import { createBrowserRouter } from "react-router";
import { RequireAuth } from "./components/require-auth.tsx";
import { HomePage } from "./pages/home-page.tsx";
import { LoginPage } from "./pages/login-page.tsx";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [{ path: "/", element: <HomePage /> }],
  },
]);
