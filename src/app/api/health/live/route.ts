// Liveness: is this process able to serve at all?
//
// Deliberately checks NOTHING. If it touched the database, a brief database blip would
// make the container healthcheck kill and restart a perfectly healthy application,
// turning a recoverable dependency failure into a self-inflicted outage.
//
// Unauthenticated by necessity (it must answer before any session exists) and therefore
// returns no version, hostname, or dependency detail.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true });
}
