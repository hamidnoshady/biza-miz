import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@/lib/db";
import * as siteAuth from "@/lib/iam/site-auth";
import { POST } from "./route";

vi.mock("@/lib/db", () => ({ getPool: vi.fn(), query: vi.fn(), withTenant: vi.fn((_id: string, work: () => unknown) => work()) }));
vi.mock("@/lib/iam/site-auth", () => ({ authenticateIamSite: vi.fn() }));
vi.mock("@/lib/iam/service", () => ({ appendIamEvent: vi.fn() }));
const businessId="10000000-0000-4000-8000-000000000001",siteDeviceId="10000000-0000-4000-8000-000000000002",actorUserId="10000000-0000-4000-8000-000000000003",membershipId="10000000-0000-4000-8000-000000000004",commandId="10000000-0000-4000-8000-000000000005";
const request=(type:string,changes:Record<string,unknown>={})=>new Request("http://localhost/api/iam/commands",{method:"POST",body:JSON.stringify({commandId,type,membershipId,actorUserId,expectedRevision:7,changes})}) as never;

beforeEach(()=>{vi.clearAllMocks();vi.mocked(siteAuth.authenticateIamSite).mockResolvedValue({businessId,siteDeviceId} as never);});
describe("site IAM commands",()=>{
 it("returns a prior durable result without rerunning the mutation",async()=>{
  const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT status,result")?{rows:[{status:"rejected",result:{ok:false,error:"last_owner"}}]}:{rows:[]}),release:vi.fn()};
  vi.mocked(db.getPool).mockReturnValue({connect:vi.fn().mockResolvedValue(client)} as never);
  const response=await POST(request("membership.offboard"));
  expect(response.status).toBe(409);expect(await response.json()).toEqual({ok:false,error:"last_owner"});
  expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE users"))).toBe(false);
 });
 it("durably records rejection after rolling back and never lets a site reactivate Cloud suspension",async()=>{
  const client={query:vi.fn(async(sql:string)=>{
   if(sql.includes("SELECT status,result"))return {rows:[]};
   if(sql.includes("FROM users u"))return {rows:[
    {id:actorUserId,role:"owner",custom_role_id:null,permissions:{},membership_revision:"2",is_active:true,membership_status:"active",custom_permissions:null},
    {id:membershipId,role:"staff",custom_role_id:null,permissions:{},membership_revision:"7",is_active:false,membership_status:"suspended",custom_permissions:null},
   ]};return {rows:[],rowCount:0};}),release:vi.fn()};
  vi.mocked(db.getPool).mockReturnValue({connect:vi.fn().mockResolvedValue(client)} as never);vi.mocked(db.query).mockResolvedValue({rows:[],rowCount:1} as never);
  const response=await POST(request("membership.reactivate"));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({ok:false,error:"cloud_reactivation_required"});
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO iam_commands"),expect.arrayContaining([businessId,siteDeviceId,commandId,"membership.reactivate"]));
 });
 it("rejects a branch assignment wider than the actor's own scope",async()=>{
  const firstLocation="10000000-0000-4000-8000-000000000006",secondLocation="10000000-0000-4000-8000-000000000007";
  const client={query:vi.fn(async(sql:string)=>{
   if(sql.includes("SELECT status,result"))return {rows:[]};
   if(sql.includes("FROM users u"))return {rows:[
    {id:actorUserId,role:"manager",custom_role_id:null,permissions:{granted:["team.permissions_manage"]},membership_revision:"2",is_active:true,membership_status:"active",custom_permissions:null,location_scope:"selected",location_id:firstLocation,location_ids:[firstLocation]},
    {id:membershipId,role:"staff",custom_role_id:null,permissions:{},membership_revision:"7",is_active:true,membership_status:"active",custom_permissions:null,location_scope:"home",location_id:firstLocation,location_ids:[]},
   ]};
   if(sql.includes("SELECT id FROM locations"))return {rows:[{id:firstLocation},{id:secondLocation}],rowCount:2};
   return {rows:[],rowCount:0};}),release:vi.fn()};
  vi.mocked(db.getPool).mockReturnValue({connect:vi.fn().mockResolvedValue(client)} as never);vi.mocked(db.query).mockResolvedValue({rows:[],rowCount:1} as never);
  const response=await POST(request("membership.locations.change",{locationIds:[firstLocation,secondLocation],locationScope:"selected",defaultLocationId:firstLocation}));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({ok:false,error:"location_scope_escalation"});
  expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE users SET location_scope"))).toBe(false);
 });
});
