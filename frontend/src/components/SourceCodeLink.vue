<template>
  <!-- The AGPL requires offering the source to people who use this app over the network -->
  <a
    :href="sourceCodeUrl"
    target="_blank"
    rel="noopener"
    class="tw-text-xs tw-font-medium tw-text-gray"
  >
    Source code
  </a>
</template>

<script>
import { sourceCodeUrl } from "@/constants"

export default {
  name: "SourceCodeLink",
  data: () => ({ sourceCodeUrl }),
}
</script>
