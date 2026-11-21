import type { Express } from 'express';

import { createRuntime } from './api/runtime.ts';

const { app }: { app: Express } = createRuntime({ allowIncompleteBilling: true });

export default app;
