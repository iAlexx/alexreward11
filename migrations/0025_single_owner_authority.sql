-- Forward migration 0025: single-OWNER authority invariant (M0).
-- Additive only. Does not implement bootstrap, CO_OWNER, or ownership transfer.
--
-- Design (PostgreSQL-valid):
-- 1) admin_owner_authority singleton row (seat=1) records which admin_user_id
--    may hold OWNER. Vacant (NULL holder) = pre-bootstrap (zero Owners OK).
-- 2) AFTER trigger on admin_role_bindings serializes on the seat row (FOR UPDATE)
--    and refuses a second distinct holder. Revoking clears active_binding_id
--    but NEVER frees the seat for another admin (blocks informal transfer).
-- 3) OWNER → non-OWNER role_id changes and admin_user_id changes on OWNER
--    bindings are refused (authorized ownership transfer is out of scope).
-- 4) Partial UNIQUE index on admin_role_bindings(role_id) WHERE revoked_at IS NULL
--    AND role_id = <OWNER id resolved at migrate time> — local columns only.
-- 5) Before recording migration 0024 as applied, verify 0024 security-relevant
--    definitions (types, CHECK/PK/FK, enabled BEFORE UPDATE trigger body).
--    Never mark an unapplied/partial/incompatible 0024 as applied.
--
-- Policy: "effective OWNER" for auth remains ACTIVE admin_users + unrevoked
-- OWNER binding (application). Seat holder may be DISABLED without transferring.

BEGIN;

-- Refuse silently "picking" an Owner when data already conflicts.
DO $m0_precheck$
DECLARE
  owner_role_id uuid;
  unrevoked_count integer;
  distinct_holders integer;
BEGIN
  SELECT id INTO owner_role_id FROM admin_roles WHERE code = 'OWNER';
  IF owner_role_id IS NULL THEN
    RAISE EXCEPTION 'M0 migration refused: admin_roles OWNER row is missing';
  END IF;

  SELECT count(*)::integer,
         count(DISTINCT admin_user_id)::integer
    INTO unrevoked_count, distinct_holders
    FROM admin_role_bindings
   WHERE role_id = owner_role_id
     AND revoked_at IS NULL;

  IF unrevoked_count > 1 THEN
    RAISE EXCEPTION
      'M0 migration refused: % unrevoked OWNER bindings for distinct holders=% — resolve manually before applying',
      unrevoked_count, distinct_holders;
  END IF;

  SELECT count(DISTINCT admin_user_id)::integer
    INTO distinct_holders
    FROM admin_role_bindings
   WHERE role_id = owner_role_id;

  IF distinct_holders > 1 THEN
    RAISE EXCEPTION
      'M0 migration refused: % distinct admin_user_id values have OWNER binding history — resolve manually before applying',
      distinct_holders;
  END IF;
END
$m0_precheck$;

CREATE TABLE admin_owner_authority (
    seat                 SMALLINT PRIMARY KEY CHECK (seat = 1),
    holder_admin_user_id UUID NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
    active_binding_id    UUID NULL REFERENCES admin_role_bindings (id) ON DELETE SET NULL,
    claimed_at           TIMESTAMPTZ NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_owner_authority_vacant_or_claimed CHECK (
        (holder_admin_user_id IS NULL
            AND active_binding_id IS NULL
            AND claimed_at IS NULL)
        OR
        (holder_admin_user_id IS NOT NULL
            AND claimed_at IS NOT NULL)
    )
);

COMMENT ON TABLE admin_owner_authority IS
    'M0 singleton OWNER seat. Vacant holder = pre-bootstrap (zero Owners allowed). '
    'Revoking an OWNER binding does not clear holder_admin_user_id — informal '
    'transfer to another admin is refused until an authorized transfer procedure exists.';

CREATE TRIGGER admin_owner_authority_set_updated_at
    BEFORE UPDATE ON admin_owner_authority
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- Exactly one seat row; initially vacant.
INSERT INTO admin_owner_authority (seat) VALUES (1);

-- Seed seat from existing single-OWNER history (if any), without choosing among conflicts
-- (conflicts already refused above).
DO $m0_seed$
DECLARE
  owner_role_id uuid;
  holder uuid;
  binding uuid;
BEGIN
  SELECT id INTO STRICT owner_role_id FROM admin_roles WHERE code = 'OWNER';

  SELECT b.admin_user_id, b.id
    INTO holder, binding
    FROM admin_role_bindings b
   WHERE b.role_id = owner_role_id
     AND b.revoked_at IS NULL
   LIMIT 1;

  IF holder IS NULL THEN
    SELECT b.admin_user_id
      INTO holder
      FROM admin_role_bindings b
     WHERE b.role_id = owner_role_id
     ORDER BY b.granted_at ASC
     LIMIT 1;
    binding := NULL;
  END IF;

  IF holder IS NOT NULL THEN
    UPDATE admin_owner_authority
       SET holder_admin_user_id = holder,
           active_binding_id = binding,
           claimed_at = COALESCE(
             (SELECT granted_at FROM admin_role_bindings WHERE id = binding),
             now()
           ),
           updated_at = now()
     WHERE seat = 1;
  END IF;
END
$m0_seed$;

CREATE OR REPLACE FUNCTION app_enforce_single_owner_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  owner_role_id uuid;
  seat_holder uuid;
  old_is_owner boolean := false;
  new_is_owner boolean := false;
BEGIN
  SELECT id INTO owner_role_id FROM admin_roles WHERE code = 'OWNER';
  IF owner_role_id IS NULL THEN
    RAISE EXCEPTION 'OWNER role missing from admin_roles'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.role_id IS NOT DISTINCT FROM owner_role_id THEN
      PERFORM 1 FROM admin_owner_authority WHERE seat = 1 FOR UPDATE;
      UPDATE admin_owner_authority
         SET active_binding_id = NULL,
             updated_at = now()
       WHERE seat = 1
         AND active_binding_id IS NOT DISTINCT FROM OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE: inspect OLD and NEW role_id.
  IF TG_OP = 'UPDATE' THEN
    old_is_owner := OLD.role_id IS NOT DISTINCT FROM owner_role_id;
  END IF;
  new_is_owner := NEW.role_id IS NOT DISTINCT FROM owner_role_id;

  -- M0: refuse OWNER → non-OWNER role transitions (authorized transfer is out of scope).
  -- Keeps active_binding_id from pointing at a row that no longer represents OWNER.
  IF TG_OP = 'UPDATE' AND old_is_owner AND NOT new_is_owner THEN
    RAISE EXCEPTION
      'single-OWNER invariant: changing an OWNER binding to a non-OWNER role is refused'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Refuse reassigning an OWNER binding to a different admin_user_id.
  IF TG_OP = 'UPDATE'
     AND old_is_owner
     AND new_is_owner
     AND OLD.admin_user_id IS DISTINCT FROM NEW.admin_user_id
  THEN
    RAISE EXCEPTION
      'single-OWNER invariant: changing admin_user_id on an OWNER binding is refused'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT new_is_owner THEN
    RETURN NEW;
  END IF;

  -- NEW represents OWNER from here.
  SELECT holder_admin_user_id
    INTO seat_holder
    FROM admin_owner_authority
   WHERE seat = 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_owner_authority seat row missing'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.revoked_at IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM admin_role_bindings b
       WHERE b.role_id = owner_role_id
         AND b.revoked_at IS NULL
         AND b.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION
        'single-OWNER invariant: another unrevoked OWNER binding already exists'
        USING ERRCODE = 'unique_violation';
    END IF;

    IF seat_holder IS NULL THEN
      UPDATE admin_owner_authority
         SET holder_admin_user_id = NEW.admin_user_id,
             active_binding_id = NEW.id,
             claimed_at = now(),
             updated_at = now()
       WHERE seat = 1;
    ELSIF seat_holder = NEW.admin_user_id THEN
      UPDATE admin_owner_authority
         SET active_binding_id = NEW.id,
             updated_at = now()
       WHERE seat = 1;
    ELSE
      RAISE EXCEPTION
        'single-OWNER invariant: OWNER seat is held by another admin; informal transfer is refused'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    UPDATE admin_owner_authority
       SET active_binding_id = NULL,
           updated_at = now()
     WHERE seat = 1
       AND active_binding_id IS NOT DISTINCT FROM NEW.id;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app_enforce_single_owner_authority() IS
    'M0: enforce at-most-one OWNER seat. Vacant seat allows first claim; '
    'revoke does not free seat for a different admin_user_id; '
    'OWNER→non-OWNER role_id changes and OWNER admin_user_id changes are refused.';

CREATE TRIGGER admin_role_bindings_single_owner_authority
    AFTER INSERT OR UPDATE OR DELETE ON admin_role_bindings
    FOR EACH ROW
    EXECUTE FUNCTION app_enforce_single_owner_authority();

-- Defense in depth: partial unique index using only local columns + OWNER role_id
-- resolved once at migrate time (no JOIN/subquery in the index predicate).
DO $m0_index$
DECLARE
  owner_role_id uuid;
BEGIN
  SELECT id INTO STRICT owner_role_id FROM admin_roles WHERE code = 'OWNER';
  EXECUTE format(
    $sql$
      CREATE UNIQUE INDEX admin_role_bindings_one_unrevoked_owner
        ON admin_role_bindings (role_id)
        WHERE revoked_at IS NULL
          AND role_id = %L::uuid
    $sql$,
    owner_role_id
  );
END
$m0_index$;

COMMENT ON INDEX admin_role_bindings_one_unrevoked_owner IS
    'At most one unrevoked row may reference the OWNER role_id. role_id constant '
    'was baked from admin_roles.code=OWNER at migration 0025 apply time.';

-- Verify migration 0024 security-relevant definitions before recording it as applied.
-- Object names alone are insufficient. Never mark unapplied/partial/incompatible 0024.
-- 0024 SQL file remains immutable.
DO $m0_verify_0024$
DECLARE
  totp_is_bigint boolean := false;
  totp_check_ok boolean := false;
  has_throttle boolean := false;
  failed_attempts_ok boolean := false;
  window_started_ok boolean := false;
  locked_until_ok boolean := false;
  updated_at_ok boolean := false;
  throttle_pk_ok boolean := false;
  throttle_fk_ok boolean := false;
  failed_attempts_check_ok boolean := false;
  throttle_trigger_ok boolean := false;
  admin_user_id_uuid_ok boolean := false;
  missing text := '';
  totp_attnum int2;
  failed_attnum int2;
  totp_required constant text :=
    'check totp_last_accepted_step is null or totp_last_accepted_step >= 0';
  failed_required constant text := 'check failed_attempts >= 0';
  intended_updated_at_fn oid;
BEGIN
  -- Normalize CHECK defs to a paren-/cast-stripped form so substring/OR TRUE
  -- weakenings cannot pass (e.g. ">= 0 OR TRUE"), while still accepting
  -- equivalent parenthesization / ::bigint|::integer casts from pg_get_constraintdef.
  intended_updated_at_fn := to_regprocedure('public.app_set_updated_at()');

  -- totp_last_accepted_step: BIGINT NULL
  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class t ON t.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'admin_credentials'
       AND a.attname = 'totp_last_accepted_step'
       AND NOT a.attisdropped
       AND a.attnum > 0
       AND a.atttypid = 'bigint'::regtype
       AND NOT a.attnotnull
  ) INTO totp_is_bigint;

  SELECT a.attnum
    INTO totp_attnum
    FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'admin_credentials'
     AND a.attname = 'totp_last_accepted_step'
     AND NOT a.attisdropped
     AND a.attnum > 0;

  IF totp_attnum IS NOT NULL THEN
    SELECT bool_and(
             btrim(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     lower(regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g')),
                     '::(bigint|integer|int4|int8)',
                     '',
                     'g'
                   ),
                   '[()]',
                   '',
                   'g'
                 ),
                 '\s+',
                 ' ',
                 'g'
               )
             ) = totp_required
           )
           AND bool_and(c.convalidated)
           AND count(*) > 0
      INTO totp_check_ok
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'admin_credentials'
       AND c.contype = 'c'
       AND c.conkey IS NOT NULL
       AND totp_attnum = ANY (c.conkey);
    totp_check_ok := COALESCE(totp_check_ok, false);
  END IF;

  SELECT to_regclass('public.admin_auth_throttle') IS NOT NULL INTO has_throttle;

  IF has_throttle THEN
    -- admin_user_id: UUID NOT NULL (independent of PK/FK name checks).
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND a.attname = 'admin_user_id'
         AND NOT a.attisdropped
         AND a.attnum > 0
         AND a.atttypid = 'uuid'::regtype
         AND a.attnotnull
    ) INTO admin_user_id_uuid_ok;

    -- failed_attempts: INTEGER NOT NULL DEFAULT 0
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND a.attname = 'failed_attempts'
         AND NOT a.attisdropped
         AND a.atttypid = 'integer'::regtype
         AND a.attnotnull
         AND pg_get_expr(ad.adbin, ad.adrelid) = '0'
    ) INTO failed_attempts_ok;

    -- window_started_at: TIMESTAMPTZ NOT NULL DEFAULT now()
    -- Canonical pg_get_expr for 0024 DEFAULT now() is exactly 'now()'.
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND a.attname = 'window_started_at'
         AND NOT a.attisdropped
         AND a.atttypid = 'timestamptz'::regtype
         AND a.attnotnull
         AND pg_get_expr(ad.adbin, ad.adrelid) = 'now()'
    ) INTO window_started_ok;

    -- locked_until: TIMESTAMPTZ NULL (no NOT NULL)
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND a.attname = 'locked_until'
         AND NOT a.attisdropped
         AND a.atttypid = 'timestamptz'::regtype
         AND NOT a.attnotnull
    ) INTO locked_until_ok;

    -- updated_at: TIMESTAMPTZ NOT NULL DEFAULT now()
    -- Canonical pg_get_expr for 0024 DEFAULT now() is exactly 'now()'.
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND a.attname = 'updated_at'
         AND NOT a.attisdropped
         AND a.atttypid = 'timestamptz'::regtype
         AND a.attnotnull
         AND pg_get_expr(ad.adbin, ad.adrelid) = 'now()'
    ) INTO updated_at_ok;

    -- PRIMARY KEY specifically on admin_user_id (single column).
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND c.contype = 'p'
         AND c.convalidated
         AND (
           SELECT array_agg(a.attname::text ORDER BY u.ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = u.attnum
         ) = ARRAY['admin_user_id']::text[]
    ) INTO throttle_pk_ok;

    -- FK admin_user_id → public.admin_users.id ON DELETE CASCADE (confkey = id).
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_class ft ON ft.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_namespace fn ON fn.oid = ft.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND c.contype = 'f'
         AND c.convalidated
         AND fn.nspname = 'public'
         AND ft.relname = 'admin_users'
         AND c.confdeltype = 'c'
         AND (
           SELECT array_agg(a.attname::text ORDER BY u.ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = u.attnum
         ) = ARRAY['admin_user_id']::text[]
         AND (
           SELECT array_agg(a.attname::text ORDER BY u.ord)
             FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = c.confrelid AND a.attnum = u.attnum
         ) = ARRAY['id']::text[]
    ) INTO throttle_fk_ok;

    -- failed_attempts CHECK must be exactly (>= 0), not a weakened OR TRUE form.
    SELECT a.attnum
      INTO failed_attnum
      FROM pg_attribute a
      JOIN pg_class t ON t.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'admin_auth_throttle'
       AND a.attname = 'failed_attempts'
       AND NOT a.attisdropped
       AND a.attnum > 0;

    IF failed_attnum IS NOT NULL THEN
      SELECT bool_and(
               btrim(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       lower(regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g')),
                       '::(bigint|integer|int4|int8)',
                       '',
                       'g'
                     ),
                     '[()]',
                     '',
                     'g'
                   ),
                   '\s+',
                   ' ',
                   'g'
                 )
               ) = failed_required
             )
             AND bool_and(c.convalidated)
             AND count(*) > 0
        INTO failed_attempts_check_ok
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'admin_auth_throttle'
         AND c.contype = 'c'
         AND c.conkey IS NOT NULL
         AND failed_attnum = ANY (c.conkey);
      failed_attempts_check_ok := COALESCE(failed_attempts_check_ok, false);
    END IF;

    -- Trigger: origin-compatible enabled ('O' or 'A'), BEFORE UPDATE, FOR EACH ROW,
    -- invokes public.app_set_updated_at() (trigger-returning). Reject DISABLED ('D')
    -- and REPLICA ('R'). Unrestricted: no WHEN (tgqual IS NULL), no UPDATE OF columns
    -- (tgattr empty). tgtype bits: ROW=1, BEFORE=2, UPDATE=16.
    SELECT EXISTS (
      SELECT 1
        FROM pg_trigger tr
        JOIN pg_class c ON c.oid = tr.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = tr.tgfoid
       WHERE n.nspname = 'public'
         AND c.relname = 'admin_auth_throttle'
         AND tr.tgname = 'admin_auth_throttle_set_updated_at'
         AND NOT tr.tgisinternal
         AND tr.tgenabled IN ('O', 'A')
         AND (tr.tgtype & 1) = 1          -- FOR EACH ROW
         AND (tr.tgtype & 2) = 2          -- BEFORE
         AND (tr.tgtype & 64) = 0         -- not INSTEAD OF
         AND (tr.tgtype & (4|8|16|32)) = 16  -- UPDATE only (not INSERT/DELETE/TRUNCATE)
         AND tr.tgqual IS NULL            -- no WHEN (...) condition
         AND tr.tgattr = ''::int2vector   -- no UPDATE OF column restriction
         AND intended_updated_at_fn IS NOT NULL
         AND tr.tgfoid = intended_updated_at_fn
         AND p.prorettype = 'trigger'::regtype
    ) INTO throttle_trigger_ok;
  END IF;

  IF NOT totp_is_bigint THEN
    missing := missing || ' admin_credentials.totp_last_accepted_step BIGINT NULL';
  END IF;
  IF NOT totp_check_ok THEN
    missing := missing || ' totp_last_accepted_step nonnegative CHECK';
  END IF;
  IF NOT has_throttle THEN
    missing := missing || ' admin_auth_throttle';
  END IF;
  IF has_throttle AND NOT admin_user_id_uuid_ok THEN
    missing := missing || ' admin_auth_throttle.admin_user_id UUID NOT NULL';
  END IF;
  IF has_throttle AND NOT failed_attempts_ok THEN
    missing := missing || ' admin_auth_throttle.failed_attempts INTEGER NOT NULL DEFAULT 0';
  END IF;
  IF has_throttle AND NOT window_started_ok THEN
    missing := missing || ' admin_auth_throttle.window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
  IF has_throttle AND NOT locked_until_ok THEN
    missing := missing || ' admin_auth_throttle.locked_until TIMESTAMPTZ NULL';
  END IF;
  IF has_throttle AND NOT updated_at_ok THEN
    missing := missing || ' admin_auth_throttle.updated_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
  IF has_throttle AND NOT throttle_pk_ok THEN
    missing := missing || ' admin_auth_throttle PRIMARY KEY (admin_user_id)';
  END IF;
  IF has_throttle AND NOT throttle_fk_ok THEN
    missing := missing
      || ' admin_auth_throttle FK admin_user_id→admin_users.id ON DELETE CASCADE';
  END IF;
  IF has_throttle AND NOT failed_attempts_check_ok THEN
    missing := missing || ' admin_auth_throttle.failed_attempts CHECK (>= 0)';
  END IF;
  IF has_throttle AND NOT throttle_trigger_ok THEN
    missing := missing
      || ' admin_auth_throttle_set_updated_at tgenabled IN (O,A) BEFORE UPDATE FOR EACH ROW'
      || ' unrestricted(tgqual NULL,tgattr empty)→app_set_updated_at()';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION
      'M0 migration refused: migration 0024 prerequisites incomplete — will not mark 0024 as applied. missing:%',
      missing;
  END IF;
END
$m0_verify_0024$;

-- Record 0024 only after prerequisite verification succeeded (0024 file omitted this INSERT).
INSERT INTO schema_migrations (version)
VALUES ('0024_owner_admin_auth_hardening')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0025_single_owner_authority')
ON CONFLICT (version) DO NOTHING;

COMMIT;
