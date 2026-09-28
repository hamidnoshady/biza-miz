import { describe, expect, it } from "vitest";
import { applyIamEvent, sequenceDecision } from "./reconciliation";
import type { IamEvent, IamMembership } from "./model";

const membership: IamMembership = { id:"u",businessId:"b",cloudIdentityRef:null,role:"manager",customRoleId:null,fullName:"A",email:null,
  isActive:true,status:"active",overrides:{},locationScope:"all",defaultLocationId:null,locationIds:[],revision:1 };
const event = (sequence:number, type:IamEvent["eventType"]="membership.profile_updated"): IamEvent => ({ id:`e${sequence}`,businessId:"b",sequence,
  eventType:type,entityType:"membership",entityId:"u",schemaVersion:1,payload:{membership},actorUserId:null,origin:"cloud",createdAt:new Date(0).toISOString() });

describe("IAM ordered reconciliation", () => {
  it("applies only the exact next sequence", () => {
    expect(sequenceDecision(4,event(5))).toEqual({action:"apply"});
    expect(sequenceDecision(5,event(5))).toEqual({action:"ignore_duplicate"});
    expect(sequenceDecision(4,event(6))).toEqual({action:"recover_gap",expected:5,received:6});
  });
  it("dead-letters incompatible versions", () => {
    expect(sequenceDecision(0,{...event(1),schemaVersion:99})).toEqual({action:"dead_letter",code:"unsupported_schema"});
  });
  it("Cloud suspension wins over stale local active state", () => {
    const state={memberships:new Map([["u",membership]]),roles:new Map()};
    applyIamEvent(state,{...event(2,"membership.suspended"),payload:{revision:2}});
    expect(state.memberships.get("u")).toMatchObject({isActive:false,status:"suspended",revision:2});
  });
  it("older canonical revisions cannot overwrite newer state", () => {
    const newer={...membership,role:"cashier" as const,revision:3};
    const state={memberships:new Map([["u",newer]]),roles:new Map()};
    applyIamEvent(state,{...event(2),payload:{membership:{...membership,revision:2}}});
    expect(state.memberships.get("u")?.role).toBe("cashier");
  });
});
