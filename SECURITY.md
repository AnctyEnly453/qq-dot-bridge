# Security

Do not put credentials, private configuration, account IDs, chat content, response captures, SQLite files or environment dumps in issues or pull requests. Reproduce problems with synthetic accounts and redacted logs.

The service is a scoped messaging bridge, not a permission system for the assistant's intent. The caller remains responsible for obtaining authorization for messages and other changes. Only trusted administrators may edit configuration or deploy code.

Keep keys and state outside version control. Loss of send ledgers can remove duplicate-send protection; preserve them and investigate uncertain results before retrying. Revoke compromised client keys through the administrator's normal security process; this release supports one client key per instance and requires restart after changes.

Use a valid HTTPS certificate and do not expose the loopback gateway, NapCat API or Docker daemon publicly. Docker access grants strong host authority. Review the deployment boundary before granting it to any service account.

This release has offline and simulated integration coverage, not an independent security audit. Please report suspected vulnerabilities with a minimal reproduction and no private data.
