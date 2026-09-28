import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient } from './api/queries.js';
import { createRoutes } from './router.js';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createBrowserRouter(createRoutes()));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
