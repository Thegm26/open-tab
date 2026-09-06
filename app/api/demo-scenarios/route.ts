import { NextRequest } from "next/server";
import { error, installOwner, json, rateLimit } from "@/lib/server/http";
import { store } from "@/lib/server/store";

export async function POST(request: NextRequest) {
  try {
    await rateLimit(request, "scenario-create", 10, 60_000);
    const bootstrapSecret = request.headers.get("x-demo-bootstrap") ?? "";
    const result = await store.createOrRecoverScenario({ bootstrapSecret, idempotencyKey: request.headers.get("idempotency-key") ?? "" });
    const response = json({ scenario: result.scenario, merchants: [{ slug: "cafe", name: "Café Sol" }, { slug: "bakery", name: "Bread & Butter Bakery" }] });
    installOwner(response, result.scenario.id, result.ownerToken, result.csrfToken);
    return response;
  } catch (cause) { return error(cause); }
}
