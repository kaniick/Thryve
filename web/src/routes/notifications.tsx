import { createFileRoute } from '@tanstack/react-router'
import { NotificationsPage } from '@/src/components/Notifications/NotificationsPage'

export const Route = createFileRoute('/notifications')({ component: NotificationsPage })
