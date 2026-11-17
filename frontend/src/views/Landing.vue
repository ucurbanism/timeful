<template>
  <!-- The home page is just the poll form, so it can be embedded in another site -->
  <div class="tw-flex tw-min-h-full tw-flex-col tw-items-center tw-px-4 tw-py-6">
    <NewEvent :dialog="false" class="tw-w-full" />
    <SourceCodeLink class="tw-mt-4" />
  </div>
</template>

<script>
import NewEvent from "@/components/NewEvent.vue"
import SourceCodeLink from "@/components/SourceCodeLink.vue"

export default {
  name: "Landing",

  metaInfo: {
    title: "Find a time to meet",
  },

  components: { NewEvent, SourceCodeLink },
}
</script>
