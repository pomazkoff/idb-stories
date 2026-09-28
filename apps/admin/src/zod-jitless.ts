/**
 * Строгий CSP без 'unsafe-eval' (раздел 10.6): zod по умолчанию пробует собрать быстрый парсер
 * через `new Function`, и эта проверка порождает нарушение CSP. Режим jitless отключает JIT.
 * Модуль импортируется первым в main.tsx — до первой валидации схем.
 */
import { disableZodJit } from '@idb-stories/schema';

disableZodJit();
