import type { NextConfig } from "next";
const nextConfig: NextConfig = {
 poweredByHeader:false,
 reactStrictMode:true,
 async headers(){return [{source:"/:path*",headers:[
  {key:"X-Content-Type-Options",value:"nosniff"},
  {key:"X-Frame-Options",value:"DENY"},
  {key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},
  {key:"Permissions-Policy",value:"camera=(), microphone=(), geolocation=()"},
 ]}];},
 async redirects(){return [
  {source:"/",destination:"/id",permanent:true},
  {source:"/products/quadriga",destination:"/id/products/quadriga",permanent:true},
 ];},
};
export default nextConfig;
