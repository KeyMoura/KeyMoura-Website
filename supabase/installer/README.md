# Database bootstrap

The browser never receives a database password. Apply the additive core migration
from a trusted workstation, then apply only the optional module files selected
for the deployment:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/installer/00000000000000_installer_core.sql \
  -f supabase/installer/00000000000001_security_bootstrap.sql \
  -f supabase/installer/00000000000002_application_baseline.sql
# Garage remains separately selectable because it also provisions its storage bucket.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/installer/modules/garage.sql
```

The core file is idempotent and additive. It does not delete production data.
Existing timestamped migrations remain unchanged for S-Chassis compatibility.
Module disablement is an application state change, never a schema rollback.

`00000000000002_application_baseline.sql` is the complete additive baseline for
the current application. It includes audit/security support, notifications,
moderation/reports, Forum, Knowledge Base and staff to-do, Messaging, and Shops.
It may also be applied once to an existing partial installation to repair missing
application objects; it does not remove existing rows or tables.
