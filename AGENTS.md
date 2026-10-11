# HELIX Portal Update Rules

- For every update to the HELIX Admin and VIP Member portals, never use native browser popups (`alert`, `confirm`, or `prompt`). Use the branded in-app HELIX dialog system.
- Require a clear, explicit in-app confirmation before any role, permission, account, license, email, publication, or other replacement/status change is submitted. State what will change and its effect; collect an audit reason where the backend requires one.
- Role and permission changes must be enforced by authenticated server-side authorization and an audited database operation; frontend role checks alone are not security controls.
- Apply these rules to future portal work and preserve existing menu/function behavior unless the user asks otherwise.
