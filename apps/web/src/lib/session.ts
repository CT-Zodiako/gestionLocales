import { queryOptions } from "@tanstack/react-query";
import { fetchMe } from "./api.ts";

export const meQueryKey = ["me"];

/** Session query shared by the login page, the guard and the home page. */
export const meQueryOptions = queryOptions({
  queryKey: meQueryKey,
  queryFn: fetchMe,
  retry: false,
});
