import { currentUser } from '@/lib/auth'
import MobileScan from '@/components/MobileScan'

/**
 * Validation on a handheld, at /scan.
 *
 * A separate route rather than a breakpoint on the desktop tab: the two are
 * different tools. This one has no tables, no site picker in the way, and one
 * job - scan two labels and be told loudly whether they agree.
 */
export const dynamic = 'force-dynamic'

export default async function Page() {
  let user = null
  try {
    user = await currentUser()
  } catch {
    // SESSION_SECRET missing - the sign-in form says so.
  }
  return <MobileScan initialUser={user ? { name: user.name, role: user.role } : null} />
}
