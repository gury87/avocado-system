import { requireAdmin } from "@/app/lib/admin-server";
import { backupError, backupOverview, startBackup } from "@/app/lib/backup-server";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return Response.json(await backupOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return backupError(error); }
}
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const result = await startBackup();
    return Response.json(result, { status: result.accepted ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return backupError(error); }
}
