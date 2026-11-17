import Vue from "vue"
import VueRouter from "vue-router"
import Landing from "@/views/Landing"

Vue.use(VueRouter)

const routes = [
  {
    path: "/",
    name: "landing",
    component: Landing,
  },
  // Names-only build: account pages and groups are gone. Their names stay as redirects because
  // other components still link to them.
  { path: "/home", name: "home", redirect: { name: "landing" } },
  { path: "/settings", name: "settings", redirect: { name: "landing" } },
  { path: "/g/:groupId", name: "group", redirect: { name: "landing" } },
  { path: "/sign-in", name: "sign-in", redirect: { name: "landing" } },
  { path: "/sign-up", name: "sign-up", redirect: { name: "landing" } },
  { path: "/auth", name: "auth", redirect: { name: "landing" } },
  {
    path: "/e/:eventId",
    name: "event",
    component: () => import("@/views/Event.vue"),
    props: true,
  },
  {
    path: "/e/:eventId/responded",
    name: "responded",
    component: () => import("@/views/Responded.vue"),
    props: true,
  },
  {
    path: "/s/:signUpId",
    name: "signUp",
    component: () => import("@/views/SignUp.vue"),
    props: true,
  },
  {
    path: "/privacy-policy",
    name: "privacy-policy",
    component: () => import("@/views/PrivacyPolicy.vue"),
  },
  {
    path: "*",
    name: "404",
    component: () => import("@/views/PageNotFound.vue"),
  },
]

const router = new VueRouter({
  mode: "history",
  base: process.env.BASE_URL,
  routes,
})

export default router
