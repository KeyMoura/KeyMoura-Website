import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";

const SUPPLIER_COLUMNS =
  "id,name,website,contact_name,email,phone,typical_lead_time_days,minimum_order_quantity,notes," +
  "supplier_materials!supplier_materials_supplier_id_fkey(" +
  "material:materials!supplier_materials_material_id_fkey(id,name,sku)," +
  "supplier_sku,last_purchase_price_cents,last_purchased_at,minimum_order_quantity)";

type SupplierMaterialEmbed = {
  material: { id: string; name: string; sku: string } | null;
  supplier_sku: string | null;
  last_purchase_price_cents: number | null;
  last_purchased_at: string | null;
  minimum_order_quantity: number | null;
};

type SupplierRow = {
  id: string;
  name: string;
  website: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  typical_lead_time_days: number | null;
  minimum_order_quantity: number | null;
  notes: string | null;
  supplier_materials: SupplierMaterialEmbed[] | null;
};

const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);

export async function GET(req: NextRequest) {
  if (!(await requirePermission(req, "suppliers.view"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await routeServiceClient
    .from("suppliers")
    // A supplier also has materials that merely name it as preferred. This
    // explicit junction relationship returns actual purchasing associations.
    .select(SUPPLIER_COLUMNS)
    .is("archived_at", null)
    .order("name");
  if (error) {
    logLifecycleFailure("load_suppliers", error);
    return NextResponse.json({ error: "Could not load suppliers." }, { status: 500 });
  }

  const suppliers = (data ?? []) as unknown as SupplierRow[];
  const items = suppliers.map((supplier) => {
    const associations = supplier.supplier_materials ?? [];
    return {
      ...supplier,
      // Preserve the response shape used by BusinessManager while retaining
      // purchasing metadata for a future supplier detail screen.
      materials: associations.flatMap((association) =>
        association.material
          ? [{ ...association.material, supplier_sku: association.supplier_sku }]
          : []
      ),
      material_associations: associations,
      supplier_materials: undefined,
    };
  });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  if (!(await requirePermission(req, "suppliers.manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || clean(body.name, 160).length < 2) {
    return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });
  }
  const leadDays = body.leadDays === "" ? null : Number(body.leadDays);
  if (leadDays !== null && (!Number.isInteger(leadDays) || leadDays < 0)) {
    return NextResponse.json(
      { error: "Lead time must be a non-negative whole number." },
      { status: 400 }
    );
  }

  const { data, error } = await routeServiceClient
    .from("suppliers")
    .insert({
      name: clean(body.name, 160),
      website: clean(body.website) || null,
      contact_name: clean(body.contactName, 160) || null,
      email: clean(body.email, 254) || null,
      phone: clean(body.phone, 80) || null,
      notes: clean(body.notes, 4000) || null,
      typical_lead_time_days: leadDays,
    })
    .select("id,name,website,contact_name,email,phone,typical_lead_time_days,minimum_order_quantity,notes")
    .single();
  if (error) {
    logLifecycleFailure("create_supplier", error);
    return NextResponse.json({ error: "Could not save supplier." }, { status: 400 });
  }
  return NextResponse.json({ item: { ...data, materials: [], material_associations: [] } }, { status: 201 });
}
import { NextRequest, NextResponse } from "next/server"; import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
const clean=(v:unknown,max=500)=>String(v??"").trim().slice(0,max);
export async function GET(req:NextRequest){if(!await requirePermission(req,"suppliers.view"))return NextResponse.json({error:"Forbidden"},{status:403});const {data,error}=await routeServiceClient.from("suppliers").select("id,name,website,contact_name,email,phone,typical_lead_time_days,minimum_order_quantity,notes,materials(id,name,sku)").is("archived_at",null).order("name");return error?NextResponse.json({error:"Could not load suppliers."},{status:500}):NextResponse.json({items:data??[]});}
export async function POST(req:NextRequest){if(!await requirePermission(req,"suppliers.manage"))return NextResponse.json({error:"Forbidden"},{status:403});const b=await req.json().catch(()=>null);if(!b||clean(b.name,160).length<2)return NextResponse.json({error:"Supplier name is required."},{status:400});const lead=b.leadDays===""?null:Number(b.leadDays);if(lead!==null&&(!Number.isInteger(lead)||lead<0))return NextResponse.json({error:"Lead time must be a non-negative whole number."},{status:400});const {data,error}=await routeServiceClient.from("suppliers").insert({name:clean(b.name,160),website:clean(b.website)||null,contact_name:clean(b.contactName,160)||null,email:clean(b.email,254)||null,phone:clean(b.phone,80)||null,notes:clean(b.notes,4000)||null,typical_lead_time_days:lead}).select().single();return error?NextResponse.json({error:"Could not save supplier."},{status:400}):NextResponse.json({item:data},{status:201});}

