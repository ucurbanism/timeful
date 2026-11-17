<template>
  <div
    class="tw-flex tw-h-full tw-flex-col tw-items-center tw-justify-center tw-p-2"
  >
    <div class="tw-mb-8 tw-max-w-[19rem]">
      <h1 class="tw-mb-2 tw-text-center tw-text-2xl tw-font-medium">
        404 - Page not found
      </h1>
      <div class="tw-text-center tw-text-dark-gray">
        The page you’re looking for doesn’t exist or an error occurred.
      </div>
    </div>
    <v-btn :to="{ name: 'landing' }" color="primary">Make a poll</v-btn>
  </div>
</template>

<script>
import { isPhone } from "@/utils"

export default {
  name: "PageNotFound",

  metaInfo: {
    title: "Page not found",
  },

  computed: {
    isPhone() {
      return isPhone(this.$vuetify)
    },
  },
}
</script>
