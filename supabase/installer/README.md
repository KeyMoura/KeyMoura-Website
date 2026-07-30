# Database bootstrap

The browser never receives a database password. Apply the additive core migration
from a trusted workstation, then apply only the optional module files selected
for the deployment:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/installer/00000000000000_installer_core.sql \
  -f supabase/installer/00000000000001_security_bootstrap.sql
# Examples, only when selected:
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/installer/modules/garage.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/installer/modules/vendors.sql
```

The core file is idempotent and additive. It does not delete production data.
Existing timestamped migrations remain unchanged for S-Chassis compatibility.
Module disablement is an application state change, never a schema rollback.

The remaining approved modules depend on production DDL that is not present in
this repository. Until the sanitized schema export is supplied, select them only
for an existing compatible S-Chassis database. They are recorded by the wizard
but the bootstrap command deliberately does not invent incompatible replacement
schemas.
