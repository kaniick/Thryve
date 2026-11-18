import { createFileRoute } from '@tanstack/react-router'
import { SensorHistoryPage } from '@/src/components/Sensors/SensorHistoryPage'

export const Route = createFileRoute('/sensors/$id')({ component: SensorHistoryPage })
