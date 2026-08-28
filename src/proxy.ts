import {
  clerkMiddleware,
  createRouteMatcher,
} from "@clerk/nextjs/server";

// Page routes only. API routes deliberately stay out of this list: auth.protect()
// answers a non-document request with an HTML 404, which the browser client cannot
// parse as JSON. Every /api route enforces auth + ACTIVE itself and replies with
// JSON 401/403. The config.matcher below still runs clerkMiddleware on /api/*, which
// is what makes auth() work inside those handlers.
const isProtectedRoute = createRouteMatcher([
  "/chat(.*)",
  "/admin(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
