# Explicit SQL migrations

Phase 1 intentionally contains no SQL migration. Phase 2 will add the approved baseline using
ordered, immutable explicit SQL files named `NNNN_description.sql`. The validation script already
enforces naming, ordering, transaction markers, and prohibits a mutable `users.balance` column.
