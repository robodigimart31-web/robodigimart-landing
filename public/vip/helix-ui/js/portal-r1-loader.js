(() => {
  const styles=['/vip/helix-ui/css/tokens.css','/vip/helix-ui/css/components.css','/vip/helix-ui/css/portal-adapter.css','/vip/helix-ui/css/portal-r1.css?v=member-canary-icon-dark-20261012'];
  for(const href of styles)if(!document.querySelector(`link[href="${href}"]`)){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link)}
  for(const src of ['/vip/helix-ui/js/helix-ui.js?v=member-canary-icon-dark-20261012',...(location.pathname.startsWith('/vip/login')?[]:['/vip/helix-ui/js/idle-timeout.js?v=idle-30m-20261012b','/vip/helix-ui/js/portal-r1.js?v=telemetry-v18h-20261012'])])if(!document.querySelector(`script[src="${src}"]`)){const script=document.createElement('script');script.src=src;script.defer=true;document.head.append(script)}
})();
