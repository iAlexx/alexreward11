-- Forward migration 0026: M1 Stage B owner bootstrap grant/attempt state (local + future ops).
-- Additive only. Does not lift FS-01 default-deny. Does not establish production trust.
-- Secrets (channel_sk, tickets plaintext, passwords, TOTP) are NEVER stored here.

BEGIN;

CREATE TABLE owner_bootstrap_grants (
    grant_id              UUID PRIMARY KEY,
    nonce_hex             CHAR(64) NOT NULL,
    key_id                TEXT NOT NULL,
    endpoint_profile_id   TEXT NOT NULL,
    deployment_env        TEXT NOT NULL,
    purpose               TEXT NOT NULL,
    payload_hash_hex      CHAR(64) NOT NULL,
    intended_subject      TEXT NOT NULL,
    iat                   BIGINT NOT NULL,
    exp                   BIGINT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'ISSUED',
    consumed_at           TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT owner_bootstrap_grants_nonce_key UNIQUE (nonce_hex),
    CONSTRAINT owner_bootstrap_grants_purpose_chk
        CHECK (purpose = 'FIRST_OWNER_ENROLLMENT'),
    CONSTRAINT owner_bootstrap_grants_env_chk
        CHECK (deployment_env IN ('production', 'staging', 'isolated_test')),
    CONSTRAINT owner_bootstrap_grants_status_chk
        CHECK (status IN ('ISSUED', 'CONSUMED', 'REVOKED')),
    CONSTRAINT owner_bootstrap_grants_consume_consistent
        CHECK (
            (status = 'CONSUMED' AND consumed_at IS NOT NULL)
            OR (status <> 'CONSUMED' AND consumed_at IS NULL)
        ),
    CONSTRAINT owner_bootstrap_grants_time_chk CHECK (exp > iat),
    CONSTRAINT owner_bootstrap_grants_nonce_hex_chk CHECK (nonce_hex ~ '^[0-9a-f]{64}$'),
    CONSTRAINT owner_bootstrap_grants_payload_hash_chk CHECK (payload_hash_hex ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE owner_bootstrap_grants IS
    'M1 Option C enrollment grant consumption ledger. No private keys or plaintext tickets.';

CREATE TABLE owner_bootstrap_attempts (
    attempt_id            UUID PRIMARY KEY,
    challenge_id          UUID NOT NULL,
    grant_id              UUID NOT NULL REFERENCES owner_bootstrap_grants (grant_id) ON DELETE RESTRICT,
    key_id                TEXT NOT NULL,
    endpoint_profile_id   TEXT NOT NULL,
    deployment_env        TEXT NOT NULL,
    intended_subject      TEXT NOT NULL,
    channel_pk            BYTEA NOT NULL,
    channel_fp_hex        CHAR(64) NOT NULL,
    issued_at             BIGINT NOT NULL,
    expires_at            BIGINT NOT NULL,
    pop_status            TEXT NOT NULL DEFAULT 'PENDING',
    ticket_id             UUID NULL,
    enrollment_ticket_hash CHAR(64) NULL,
    ticket_expires_at     BIGINT NULL,
    verified_at           BIGINT NULL,
    consumed_at           TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT owner_bootstrap_attempts_challenge_key UNIQUE (challenge_id),
    CONSTRAINT owner_bootstrap_attempts_channel_fp_chk CHECK (channel_fp_hex ~ '^[0-9a-f]{64}$'),
    CONSTRAINT owner_bootstrap_attempts_channel_pk_len CHECK (octet_length(channel_pk) = 32),
    CONSTRAINT owner_bootstrap_attempts_pop_status_chk
        CHECK (pop_status IN (
            'PENDING', 'VERIFIED', 'CONSUMED', 'ABORTED', 'SUPERSEDED', 'EXPIRED'
        )),
    CONSTRAINT owner_bootstrap_attempts_ticket_hash_chk
        CHECK (enrollment_ticket_hash IS NULL OR enrollment_ticket_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT owner_bootstrap_attempts_ticket_consistent
        CHECK (
            (pop_status = 'PENDING'
                AND ticket_id IS NULL
                AND enrollment_ticket_hash IS NULL
                AND ticket_expires_at IS NULL
                AND verified_at IS NULL)
            OR (pop_status = 'VERIFIED'
                AND ticket_id IS NOT NULL
                AND enrollment_ticket_hash IS NOT NULL
                AND ticket_expires_at IS NOT NULL
                AND verified_at IS NOT NULL)
            OR (pop_status = 'CONSUMED'
                AND ticket_id IS NOT NULL
                AND verified_at IS NOT NULL)
            OR (pop_status IN ('ABORTED', 'SUPERSEDED', 'EXPIRED'))
        )
);

COMMENT ON TABLE owner_bootstrap_attempts IS
    'Stored enrollment challenge/attempt state with immutable channel binding. No channel_sk.';

CREATE INDEX owner_bootstrap_attempts_grant_active_idx
    ON owner_bootstrap_attempts (grant_id, pop_status)
    WHERE pop_status IN ('PENDING', 'VERIFIED');

CREATE TABLE owner_bootstrap_attempt_nonces (
    attempt_id   UUID NOT NULL REFERENCES owner_bootstrap_attempts (attempt_id) ON DELETE CASCADE,
    purpose      TEXT NOT NULL,
    nonce_hex    CHAR(64) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (attempt_id, purpose, nonce_hex),
    CONSTRAINT owner_bootstrap_attempt_nonces_purpose_chk
        CHECK (purpose IN ('channel_pop', 'channel_cred', 'channel_abort')),
    CONSTRAINT owner_bootstrap_attempt_nonces_hex_chk CHECK (nonce_hex ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE owner_bootstrap_attempt_nonces IS
    'One-time channel proof nonces per attempt. Does not prevent first-use of a stolen complete request.';

CREATE TRIGGER owner_bootstrap_attempts_set_updated_at
    BEFORE UPDATE ON owner_bootstrap_attempts
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0026_owner_bootstrap_grants')
ON CONFLICT (version) DO NOTHING;

COMMIT;
