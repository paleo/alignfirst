import { createChannelMockRuntimeStore } from "@paleo/openclaw-channel-mock-core";

const store = createChannelMockRuntimeStore("discord-mock");
export const setDiscordMockRuntime = store.setRuntime;
export const getDiscordMockRuntime = store.getRuntime;
