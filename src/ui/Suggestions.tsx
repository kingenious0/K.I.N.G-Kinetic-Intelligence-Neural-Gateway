import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * Rotating example commands, shown only while idle.
 *
 * A voice interface has no menus — nothing tells you what it can do. This is
 * the affordance. It disappears the moment JARVIS is doing anything, so it
 * never competes with the answer.
 *
 * Each line is phrased the way you'd actually say it, not as a feature name.
 */
const EXAMPLES = [
  'give me an infrastructure check',
  'what changed in my open pull requests',
  'how many users are in the database',
  'trigger a production deployment for the portal',
  'search GitHub for a dashboard boilerplate',
  "what's on my calendar tomorrow",
  'read me the top story on Hacker News',
  'open my GitHub notifications',
  "summarise what's in my inbox",
  "what's the weather looking like",
]

const ROTATE_MS = 4200

export function Suggestions() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Only while genuinely idle, and only until the first exchange — once the
  // user knows how it works, the prompt is just clutter.
  if (phase !== 'dormant' || turns.length > 0) return null

  return (
    <div className="suggest">
      <span className="suggest-lead">try</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          “hey king, {EXAMPLES[i]}”
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
