import { currentUser } from '@/lib/auth'
import Station from '@/components/Station'

// Session-dependent, so never prerendered.
export const dynamic = 'force-dynamic'

export default async function Page() {
  let user = null
  try {
    user = await currentUser()
  } catch {
    // SESSION_SECRET missing - Station shows the setup message.
  }
  return <Station initialUser={user ? { name: user.name, role: user.role } : null} />
}
