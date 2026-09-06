import { InMemoryOpenTabStore } from "@/lib/domain/store";
import { SupabaseOpenTabStore } from "./supabase-store";

declare global { var openTabStore: InMemoryOpenTabStore | SupabaseOpenTabStore | undefined; }

const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const localDemo = process.env.OPEN_TAB_ALLOW_IN_MEMORY === "true" && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
// Next evaluates route modules during `next build`; runtime production still fails closed.
const buildAnalysis = process.env.NEXT_PHASE === "phase-production-build";
if (!configured && !localDemo && !buildAnalysis) throw new Error("Supabase persistence is required. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or explicitly set OPEN_TAB_ALLOW_IN_MEMORY=true for local development/tests.");
/** Supabase is selected by default; in-memory is available only through an explicit local flag. */
export const store: any = globalThis.openTabStore ?? (configured ? new SupabaseOpenTabStore() : new InMemoryOpenTabStore());
if (process.env.NODE_ENV !== "production") globalThis.openTabStore = store;
if (!configured) console.warn("[open-tab] Explicit local in-memory demo persistence enabled; never use this mode in production.");
