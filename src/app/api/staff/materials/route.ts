import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
export const runtime = "nodejs";
const clean = (v: unknown, max=240) => String(v ?? "").trim().slice(0,max);
export async function GET(req: NextRequest) {
  if (!await requirePermission(req,"materials.view")) return NextResponse.json({error:"Forbidden"},{status:403});
  const q=clean(new URL(req.url).searchParams.get("q"),80).replace(/[,()\\]/g,"");
  let query=routeServiceClient.from("materials").select("id,name,sku,specification,unit,current_quantity,average_unit_cost_cents,reorder_threshold,preferred_supplier_id,suppliers(name)").is("archived_at",null).order("name");
  if(q) query=query.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);
  const {data,error}=await query.limit(100); return error?NextResponse.json({error:"Could not load materials."},{status:500}):NextResponse.json({items:data??[]});
}
export async function POST(req: NextRequest) {
  if (!await requirePermission(req,"materials.manage")) return NextResponse.json({error:"Forbidden"},{status:403});
  const b=await req.json().catch(()=>null); const quantity=Number(b?.currentQuantity), cost=Math.round(Number(b?.averageUnitCostCents));
  if(!b||clean(b.name).length<2||clean(b.sku).length<2||!Number.isFinite(quantity)||quantity<0||!Number.isFinite(cost)||cost<0) return NextResponse.json({error:"Enter a name, unique SKU, and valid non-negative quantity and cost."},{status:400});
  const units=new Set(["board_feet","square_inches","linear_inches","pounds","pieces","sheets","ounces","feet","inches"]); if(!units.has(b.unit)) return NextResponse.json({error:"Choose a valid unit."},{status:400});
  const {data,error}=await routeServiceClient.from("materials").insert({name:clean(b.name,160),sku:clean(b.sku,80).toUpperCase(),specification:clean(b.specification,500)||null,unit:b.unit,current_quantity:quantity,average_unit_cost_cents:cost,reorder_threshold:b.reorderThreshold===""?null:Number(b.reorderThreshold),preferred_supplier_id:b.preferredSupplierId||null}).select().single();
  return error?NextResponse.json({error:error.code==="23505"?"That SKU is already in use.":"Could not save material."},{status:400}):NextResponse.json({item:data},{status:201});
}

