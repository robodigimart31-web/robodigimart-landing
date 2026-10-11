# Admin and VIP UI changes

The asset kit is copied to `public/vip/helix-ui/` and loaded through `/vip/helix-ui/`. The portal keeps its existing HTML/vanilla JS architecture, `portal.css`, event handlers, and routes. The adapter uses the kit's tokens, component styles, SVG icons, and mountain/market WebP backgrounds.

VIP retains exactly 7 menus: Dashboard, My Licenses, MT5 Accounts, License Activity, Announcements, Materials, My Profile. Dashboard includes a live API-driven performance panel with license/account/date filters and explicit no-data/mixed-currency states. Connect MT5 opens the OTP lookup and explicit account confirmation flow inside My Licenses/MT5 Accounts. Profile email change creates a request; approved requests expose the Auth verification step. Existing logout/reset/material/announcement actions remain.

Admin retains exactly 5 menus: Dashboard, Member, License, Announcement, Material. Existing invite, suspend/restore, reset, delete, license assignment/status/edit, announcement and material actions remain. License create no longer reveals a key; the legacy rotate-key action is hidden and its API is retired. Member adds an email approval queue. Account release now requests an audit reason. Create/assign license depends on the staging migration RPC.

Login/reset receives the same token and background styling. Responsive rules target narrow layouts and reduced motion. Browser visual QA is pending; local static build/reference and interactive tests remain to be run below.
