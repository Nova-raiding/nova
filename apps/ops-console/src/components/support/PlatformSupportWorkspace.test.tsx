import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import {PlatformSupportWorkspace,type PlatformSupportModel} from "./PlatformSupportWorkspace.js";
const model=(caps:string[])=>({authorization:{can:(cap:string)=>caps.includes(cap)},opsSession:{actor_id:"real-support"},workspaceDirectory:{items:[{workspaceId:"ws-real",enterpriseName:"真实企业",status:"active"}],offset:0,limit:20,hasMore:false},workspaceDirectoryLoading:false,workspaceDirectoryError:"",loadWorkspaceDirectory:vi.fn()}) as unknown as PlatformSupportModel;
describe("platform support workspace desktop boundaries",()=>{
 it("requires the authorized directory and read capability without inventing empty tickets",()=>{const html=renderToStaticMarkup(<PlatformSupportWorkspace model={model([])}/>);expect(html).toContain("缺少真实平台工单读取权限");expect(html).toContain("缺少授权企业目录读取能力");expect(html).toContain("尚未读取所选企业真实工单");expect(html).not.toContain("ws_demo");for(const label of ["读取授权企业目录","读取企业工单"]){const before=html.slice(0,html.indexOf(`>${label}<`));expect(before.slice(before.lastIndexOf("<button"))).toContain("disabled");}});
 it("shows no-order handoff and safe visibility instructions without granted reply assumptions",()=>{const html=renderToStaticMarkup(<PlatformSupportWorkspace model={model(["support.ticket.read","workspace.directory.read"])}/>);expect(html).toContain("无需订单或任务");expect(html).toContain("客户可见与内部");expect(html).toContain("不发送密码");expect(html).toContain("选择支持目标企业");expect(html).not.toContain("确认记录客户可见回复");});
});
