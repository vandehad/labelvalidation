import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { jobById, cancelJob, retryJob, finishJob, requireRelay, parseBearer, RelayDenied } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** A screen watching its job. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const id = Number((await ctx.params).id)
    const job = await jobById(db(), id)
    if (!job) return json({ error: 'No such job' }, 404)
    return json({ job })
  } catch (e) {
    return fail(e)
  }
}

/** Cancel - only a job nobody has started. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const id = Number((await ctx.params).id)
    if (!(await cancelJob(db(), id))) return json({ error: 'That job has already been picked up, or is gone.' }, 409)
    return json({ ok: true })
  } catch (e) {
    return fail(e)
  }
}

/**
 * Two callers. A relay, with its bearer key, reporting a job printed or
 * failed. Or a signed-in person asking for a failed job to be tried again.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = Number((await ctx.params).id)
    const sql = db()
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    if (parseBearer(req.headers.get('authorization'))) {
      const name = await requireRelay(sql, req)
      const ok = body.ok === true
      const done = await finishJob(sql, id, name, ok, String(body.error ?? ''))
      if (!done) return json({ error: 'That job is not yours to finish.' }, 409)
      return json({ ok: true })
    }

    await requireUser()
    if (body.action !== 'retry') return json({ error: 'action must be retry' }, 400)
    if (!(await retryJob(sql, id))) return json({ error: 'Only a failed job can be retried.' }, 409)
    return json({ ok: true })
  } catch (e) {
    if (e instanceof RelayDenied) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
