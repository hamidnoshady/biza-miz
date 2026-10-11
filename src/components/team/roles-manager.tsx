"use client";
import { useCallback,useEffect,useState } from "react";
import { PermissionEditor } from "./permission-editor";
import { ALL_PERMISSIONS,PERMISSION_METADATA,type Permission } from "@/lib/permissions";
import { ALL_ROLES } from "@/lib/roles";
import { roleLabel } from "@/lib/role-labels";
import { api,ErrorBox,Field,InfoBox,PrimaryButton,SecondaryButton,inputClass } from "@/app/dashboard/ui";
import { Dialog,DialogContent,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog";

interface TenantRole {id:string;name:string;description:string;permissions:string[];defaultLocationScope:"all"|"selected"|"home"|"none";isActive:boolean;revision:number;memberCount:number;updatedAt:string}
/**
 * Issue #854 (P2.4) — the reads here are `team.view` (any member who may see the
 * roster may see which roles exist), while every write is
 * `team.permissions.manage`. Before this the screen offered "ایجاد نقش سفارشی",
 * "ویرایش" and "بایگانی" to anyone who could reach the tab, and the refusal only
 * arrived after the editor was filled in and saved.
 */
export function RolesManager({deploymentProfile,canManagePermissions}:{deploymentProfile:"cloud"|"hybrid"|"local";canManagePermissions:boolean}){
 const [roles,setRoles]=useState<TenantRole[]>([]),[error,setError]=useState(""),[editing,setEditing]=useState<TenantRole|null|"new">(null);
 const load=useCallback(async()=>{const res=await api<{roles:TenantRole[];error?:string}>("/api/team/roles");if(res.ok)setRoles(res.data.roles);else setError(res.data.error??"دریافت نقش‌ها ناموفق بود.");},[]);
 useEffect(()=>{void load();},[load]);
 const locked=deploymentProfile==="hybrid"||!canManagePermissions;
 return <section aria-labelledby="roles-heading" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="roles-heading" className="font-semibold">نقش‌ها و دسترسی‌ها</h2><p className="mt-1 text-xs text-muted-foreground">نقش‌های سیستمی ثابت‌اند؛ نقش‌های سفارشی قابل ایجاد، ویرایش و بایگانی هستند.</p></div>
  <PrimaryButton disabled={locked} onClick={()=>setEditing("new")}>ایجاد نقش سفارشی</PrimaryButton></div>
  {deploymentProfile==="hybrid"?<InfoBox>تعریف یا افزایش دسترسی نقش در سایت Hybrid فقط پس از تأیید فضای ابری انجام می‌شود.</InfoBox>:!canManagePermissions?<InfoBox>نمایش نقش‌ها برای شما فقط‌خواندنی است؛ ایجاد یا ویرایش نقش به مجوز «مدیریت دسترسی‌ها» نیاز دارد.</InfoBox>:null}<ErrorBox>{error}</ErrorBox>
  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
   {ALL_ROLES.map(role=><div key={role} className="rounded-xl border border-border p-3"><span className="rounded-full bg-muted px-2 py-1 text-xs">سیستمی</span><p className="mt-2 font-medium">{roleLabel(role)}</p><p className="text-xs text-muted-foreground">الگوی ثابت سامانه</p></div>)}
   {roles.map(role=><div key={role.id} className="rounded-xl border border-border p-3"><div className="flex justify-between"><span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">سفارشی</span><span className="text-xs text-muted-foreground">{role.memberCount.toLocaleString("fa-IR")} عضو</span></div><p className="mt-2 font-medium">{role.name}</p><p className="min-h-8 text-xs text-muted-foreground">{role.description||"بدون توضیح"}</p><div className="mt-3 flex gap-2"><SecondaryButton disabled={locked||!role.isActive} onClick={()=>setEditing(role)}>ویرایش</SecondaryButton><SecondaryButton disabled={locked||!role.isActive} onClick={async()=>{if(role.memberCount){setError("پیش از بایگانی، اعضای این نقش را به نقش دیگری منتقل کنید.");return;}if(!confirm(`نقش «${role.name}» بایگانی شود؟`))return;
   // Issue #854 (P2.4): retiring a role is an access change, so the server
   // insists on a reason — the dialog asks for it before the request goes out.
   const archiveReason=window.prompt("دلیل بایگانی این نقش را بنویسید (حداقل ۸ نویسه):");
   if(!archiveReason||archiveReason.trim().length<8){setError("برای بایگانی نقش، دلیل را بنویسید (حداقل ۸ نویسه).");return;}
   const r=await api(`/api/team/roles/${role.id}`,{method:"PATCH",body:JSON.stringify({expectedRevision:role.revision,isActive:false,reason:archiveReason.trim()})});if(r.ok)void load();}}>بایگانی</SecondaryButton></div></div>)}
  </div>
  {editing?<RoleDialog role={editing==="new"?null:editing} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);void load();}}/>:null}
 </section>;
}
function RoleDialog({role,onClose,onSaved}:{role:TenantRole|null;onClose:()=>void;onSaved:()=>void}){
 const [name,setName]=useState(role?.name??""),[description,setDescription]=useState(role?.description??""),[selected,setSelected]=useState(new Set(role?.permissions??[])),[reason,setReason]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 // Issue #854 (GAP 10): the branch policy new members of this role inherit.
 const [scope,setScope]=useState<"all"|"selected"|"home"|"none">(role?.defaultLocationScope??"selected");
 /**
  * Issue #854 (P2.4) — when the server will require a reason.
  *
  * A new role always changes what can be granted; an edit does when it adds or
  * removes capabilities. This mirrors `updateTenantRole` exactly, so the form
  * asks for the sentence in the same cases the service insists on it.
  */
 const permissionsChanged=[...selected].sort().join("\u0000")!==[...(role?.permissions??[])].sort().join("\u0000");
 const scopeChanged=role?scope!==role.defaultLocationScope:false;
 const reasonRequired=!role||permissionsChanged||scopeChanged;
 async function save(){if(!name.trim()){setError("نام نقش را وارد کنید.");return;}const risky=[...selected].filter(p=>{const m=PERMISSION_METADATA.get(p as Permission);return m?.risk==="high"||m?.risk==="critical";});if(reasonRequired&&reason.trim().length<8){setError("برای تعریف یا تغییر دسترسی‌های این نقش، دلیل را ثبت کنید (حداقل ۸ نویسه).");return;}if(risky.length&&!confirm("این نقش شامل دسترسی‌های حساس است. ادامه می‌دهید؟"))return;setBusy(true);const res=await api<{error?:string}>(role?`/api/team/roles/${role.id}`:"/api/team/roles",{method:role?"PATCH":"POST",body:JSON.stringify({...(role?{expectedRevision:role.revision}:{}),name:name.trim(),description:description.trim(),permissions:[...selected],...(role?(scopeChanged?{defaultLocationScope:scope}:{}):{defaultLocationScope:scope}),reason:reason.trim()||undefined})});setBusy(false);if(!res.ok){setError(res.data.error??"ذخیره ناموفق بود.");return;}onSaved();}
 return <Dialog open onOpenChange={v=>!v&&onClose()}><DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{role?"ویرایش نقش سفارشی":"نقش سفارشی جدید"}</DialogTitle></DialogHeader><ErrorBox>{error}</ErrorBox><div className="grid gap-3 sm:grid-cols-2"><Field label="نام نقش"><input className={inputClass} value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="توضیح"><input className={inputClass} value={description} onChange={e=>setDescription(e.target.value)}/></Field></div>
 <div className="mt-3"><Field label="سیاست پیش‌فرض شعبه برای اعضای جدید" hint="وقتی عضوی این نقش را بدون انتخاب شعبه بگیرد، این سیاست اعمال می‌شود.">
  <select className={inputClass} value={scope} onChange={e=>setScope(e.target.value as typeof scope)}>
   <option value="all">همهٔ شعبه‌ها</option>
   <option value="selected">شعبه‌های انتخابی (نیاز به انتخاب هنگام عضوگیری)</option>
   <option value="home">فقط شعبهٔ اصلی (نیاز به تعیین هنگام عضوگیری)</option>
   <option value="none">بدون دسترسی شعبه</option>
  </select>
 </Field></div><PermissionEditor preset={new Set()} selected={selected} onChange={setSelected}/>{reasonRequired?<Field label="دلیل این تغییر دسترسی" hint="با نام شما و خودِ تغییر در سابقهٔ حسابرسی ثبت می‌شود."><textarea className={inputClass} value={reason} onChange={e=>setReason(e.target.value)} rows={2} maxLength={500} /></Field>:null}<DialogFooter><SecondaryButton onClick={onClose}>انصراف</SecondaryButton><PrimaryButton disabled={busy} onClick={save}>ذخیره</PrimaryButton></DialogFooter></DialogContent></Dialog>;
}
