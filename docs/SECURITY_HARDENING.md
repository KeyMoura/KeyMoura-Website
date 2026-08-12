# Security hardening status

The application-code hierarchy hardening is integrated. Server mutation routes now validate role rank,
target rank, actor-held permissions, and submitted permission keys against the canonical registry before
performing service-role writes. The deliberate owner/operator hierarchy exception remains, while unknown
permission keys are rejected for every actor.

The database migrations `20260811025000_public_profile_projection.sql` and
`20260811030000_security_boundary_hardening.sql` are present in source control but remain pending production
application and verification. This integration did not apply, reorder, rename, or modify either migration.
