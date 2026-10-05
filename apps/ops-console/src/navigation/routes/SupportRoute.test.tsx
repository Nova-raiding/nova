import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import type {OpsDomainPageProps} from "../opsPageRegistry.js";
import {SupportRoute} from "./SupportRoute.js";
import {domainFromLocation,visibleOpsDomains} from "../opsNavigation.js";
import {createAuthorizationProjection} from "../../authz/authorization.js";
describe("reachable platform support route",()=>{
 it("recognizes the real desktop route and renders platform methods workflow without a fake workspace",()=>{
   const authorization=createAuthorizationProjection({actor_id:"support",workspace_id:"",workspace_granted:true,workbench:"platform",scope:{type:"platform"},roles:[],capabilities:["support.ticket.read","workspace.directory.read"]},true);
   expect(domainFromLocation({pathname:"/ops/support",hash:""})).toBe("support");
   expect(visibleOpsDomains(authorization)).toContain("support");
   const model={authorization,opsSession:{actor_id:"support"},opsWorkspaceId:"",workspaceDirectory:{items:[],offset:0,limit:20,hasMore:false},workspaceDirectoryLoading:false,workspaceDirectoryError:"",loadWorkspaceDirectory:vi.fn(),supportClient:{list:vi.fn()}} as unknown as OpsDomainPageProps["model"];
   const html=renderToStaticMarkup(<SupportRoute model={model} onNavigate={()=>{}}/>);
   expect(html).toContain("平台支持工单工作台");expect(html).toContain("首单前无需订单或任务");expect(html).toContain("选择支持目标企业");expect(html).not.toContain("ws_demo");expect(html).not.toContain("客服处理顺序");
 });
 it("does not expose support navigation from a role label or write capability alone",()=>{
   const rolesOnly=createAuthorizationProjection({actor_id:"support",workspace_id:"",workspace_granted:true,workbench:"platform",scope:{type:"platform"},roles:["platform_admin"],capabilities:[]},true);
   expect(visibleOpsDomains(rolesOnly)).not.toContain("support");
   const writeOnly=createAuthorizationProjection({actor_id:"support",workspace_id:"",workspace_granted:true,workbench:"platform",scope:{type:"platform"},roles:[],capabilities:["support.ticket.update"]},true);
   expect(visibleOpsDomains(writeOnly)).not.toContain("support");
 });
});
