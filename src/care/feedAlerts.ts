/** Keep existing HA entities and saved notification rules following the new Feed chore. */
export const FEED_ALERT = 'chore_feed'
export const LEGACY_FEED_ALERT = 'reminder_nutrients'

export const currentFeedAlert = (kind: string) => kind === LEGACY_FEED_ALERT ? FEED_ALERT : kind
