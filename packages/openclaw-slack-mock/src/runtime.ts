import { createChannelMockRuntimeStore } from "@paleo/openclaw-channel-mock-core";

const store = createChannelMockRuntimeStore("slack-mock");
export const setSlackMockRuntime = store.setRuntime;
export const getSlackMockRuntime = store.getRuntime;
