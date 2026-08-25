package com.yu.mboocode.llm;

import dev.langchain4j.model.chat.request.ChatRequestParameters;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.TokenStream;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;
import dev.langchain4j.service.memory.ChatMemoryAccess;

/**
 * 编码助手 AI Service。
 *
 * <p>继承 ChatMemoryAccess 以便上下文管理在直接改写 messages_json 后驱逐进程内缓存的记忆，
 * 保证下一次调用从持久化存储重新加载。</p>
 */
public interface AiCodeService extends ChatMemoryAccess {
    @SystemMessage(fromResource = "prompt/system-prompt.txt")
    TokenStream chatStream(@MemoryId String memoryId, @UserMessage String message, @V("runtimeEnvironment") String runtimeEnvironment,
                           @V("workspaceInstructions") String workspaceInstructions, @V("availableSkills") String availableSkills,
                           ChatRequestParameters params);
}
