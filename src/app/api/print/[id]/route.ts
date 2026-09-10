import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { json, fail } from '@/lib/api'
import { jobById, jobStatus, cancelJob, retryJob, releaseJob, finishJob, requireRelay, parseBearer, RelayDenied } from '@/lib/printq'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** A screen watching its job - or the relay, between pieces, asking whether to carry on. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const id = Number((await ctx.params).id)
    const sql = db()
    if (parseBearer(req.headers.get('authorization'))) {
      await requireRelay(sql, req)
      const status = await jobStatus(sql, id)
      if (!status) return json({ error: 'No such job' }, 404)
      return json({ status })
    }
    await requireUser()
    const job = await jobById(sql, id)
    if (!job) return json({ error: 'No such job' }, 404)
    return json({ job })
  } catch (e) {
    if (e instanceof RelayDenied) return json({ error: e.message }, e.status)
    return fail(e)
  }
}

/** Cancel - only a job nobody has started: held, or queued and not yet claimed. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireUser()
    const id = Number((await ctx.params).id)
    const r = await cancelJob(db(), id)
    if (!r) return json({ error: 'That job has already finished, or is gone.' }, 409)
    return json({ ok: true, result: r })
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
      const done = await finishJob(sql, id, name, ok, String(body.error ?? ''), body.stopped === true)
      if (!done) return json({ error: 'That job is not yours to finish.' }, 409)
      return json({ ok: true })
    }

    await requireUser()
    if (body.action === 'release') {
      if (!(await releaseJob(sql, id))) return json({ error: 'Only a held job can be released.' }, 409)
      return json({ ok: true })
    }
    if (body.action !== 'retry') return json({ error: 'action must be retry or release' }, 400)
    if (!(await retryJob(sql, id))) return json({ error: 'Only a failed job can be retried.' }, 409)
    return json({ ok: true })
  } catch (e) {
    if (e instanceof RelayDenied) return json({ error: e.message }, e.status)
    return fail(e)
  }
}
