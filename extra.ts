import { init, Tiktoken } from "https://esm.sh/@dqbd/tiktoken@1.0.7/lite/init";
import { load } from "https://esm.sh/@dqbd/tiktoken@1.0.7/load";
import registry from "https://esm.sh/@dqbd/tiktoken@1.0.7/registry.json" assert { type: "json" };
import models from "https://esm.sh/@dqbd/tiktoken@1.0.7/model_to_encoding.json" assert { type: "json" };
import { Configuration, CreateChatCompletionResponse, CreateChatCompletionResponseChoicesInner, CreateCompletionResponseUsage, OpenAIApi } from 'https://esm.sh/openai@3.2.1';

import { YoutubeTranscript } from "./main.ts";

type ObjectValues<T> = T[keyof T];
type Model = keyof typeof models
type Encoder = ObjectValues<typeof models>
type EncoderConfig = ObjectValues<typeof registry>
type Registry = Record<Encoder, EncoderConfig>;

let _init = false;

export class Tokenizer {
    static _encoder: Tiktoken;
    static async tokenize(text: string, modelName?: Model) {
        if (!this._encoder) {
            this._encoder = await buildEncoder(modelName ?? "gpt-3.5-turbo");
        }
        return this._encoder.encode(text);
    }
}

export class AIAgent {
    static _openAI: OpenAIApi;
    static OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

    static async createCompletion({
        systemPrompt,
        userPrompt,
        assistantPrompt = "",
        modelName,
    }: {
        systemPrompt: string,
        userPrompt: string,
        assistantPrompt?: string,
        modelName?: Model,
    }
    ) {
        let completion: CreateChatCompletionResponse;
        try {
            const resp = await this._openAI.createChatCompletion({
                model: modelName ?? "gpt-3.5-turbo",
                messages: [
                    {   role: "system",
                        content: systemPrompt,
                    },
                    {   role: "user",
                        content: userPrompt,
                    },
                    {   role: "assistant",
                        content: assistantPrompt,
                    },
                ],
                temperature: 0.7,
                top_p: 0.9,
                frequency_penalty: 0.5,
                presence_penalty: 0,
            });
            completion = resp.data;
        } catch(err) {
            console.error(`Failed to process completion: ${err}`);
            throw err;
        }
        return completion
    }

    static processCompletion(completion: CreateChatCompletionResponse) {
        const { choices, usage = {}, id: completion_id } = completion;
        const { total_tokens, prompt_tokens, completion_tokens } = usage as CreateCompletionResponseUsage
        const { message, finish_reason} = choices[0] as CreateChatCompletionResponseChoicesInner;
        if (!message) {
          throw new Error(`No message returned for completion_id: ${completion_id}`);
        }
        const { content: completionText } = message
        console.log(`total_tokens: ${total_tokens}, prompt_tokens: ${prompt_tokens}, completion_tokens: ${completion_tokens}`);
        console.log(`finish_reason: ${finish_reason}, completionText: ${completionText}`);
        // return {
        //     text: completionText,
        //     total_tokens,
        // };
        return completionText
    }

    static async summarize(
        text: string,
        modelName?: Model,
        prompt?: string,
    ) {
        if (!this._openAI) {
            const configuration = new Configuration({
                apiKey: this.OPENAI_API_KEY,
            });
            this._openAI = new OpenAIApi(configuration);
        }
        const cleanText = text
            .replace(/`/g, '')
            .replace(/\n{2,}/g, '\n')
            .replace(/\s{2,}/g, ' ')
            .trim();
        const systemPrompt = "```" + `\n${cleanText}\n` + "```"
        const userPrompt = prompt || "tldr;"
        const completion = await this.createCompletion({systemPrompt, userPrompt, modelName});
        return this.processCompletion(completion);
    }

    static async summarizeBatch(texts: string[], modelName?: Model) {
        return await Promise.all(texts.map(text => this.summarize(text, modelName)));
    }
}


async function loadModel(modelName: Model) {
    if (!_init) {
        // Initialize the wasm via discussion in https://github.com/dqbd/tiktoken/issues/22
        await init(async (imports) => {
            const req = await fetch('https://esm.sh/@dqbd/tiktoken@1.0.7/lite/tiktoken_bg.wasm')
            return WebAssembly.instantiate(await req.arrayBuffer(), imports)
        });
        _init = true;
    }
    // MARK: gpt-3.5-turbo uses the cl100k_base encoding whereas text-davinci-003 uses the p50k_base
    return await load((registry as Registry)[models[modelName]]);
}
async function buildEncoder(modelName: Model) {
    const model = await loadModel(modelName);
    return new Tiktoken(
        model.bpe_ranks,
        model.special_tokens,
        model.pat_str
    );
}

async function tokenize(text: string, modelName?: Model) {
    modelName = modelName ?? "gpt-3.5-turbo"
    const encoder = await buildEncoder(modelName);
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens;
}

function* batchify<T>(arr: T[], n = 5): Generator<T[], void> {
    for (let i = 0; i < arr.length; i += n) {
      yield arr.slice(i, i + n);
    }
}

export async function splitText(text: string, maxTokens = 2048) {
    const separator = " ";
    const wordGroups = batchify(text.split(`${separator}`), 50);
    const finalChunks: string[] = [];
    let accumulated = 0;
    let growingChunk = "";
    for (let words of wordGroups) { // MARK: adding some redundancy via text overlap could help
        words = words.filter(w => w && w.trim())
        const fragment = words.join(separator);
        const tokens = (await Tokenizer.tokenize(fragment)).length;
        if (accumulated + tokens < maxTokens) { // Expand growing chunk
            growingChunk += `${fragment}${separator}`;
            accumulated += tokens;
        } else if (tokens > maxTokens) { // Unexpected case
            console.warn(`Fragment '${fragment}' of size ${tokens} exceeds limit! Skipping...`)
        }
        else { // Insert new chunk
            finalChunks.push(growingChunk.trim());
            growingChunk = fragment;
            accumulated = tokens;
        }
    }
    if (growingChunk && growingChunk.length) {
        finalChunks.push(growingChunk.trim());
    }
    return finalChunks
}

async function demoDownloadTranscript(videoId: string) {
    const text = await YoutubeTranscript.fetchTranscriptText(videoId);
    if (!text || !text.length) {
        console.error(`No transcript to write`);
        return
    }
    const dir = `./test/data/${videoId}`
    await Deno.mkdir(dir, { recursive: true })
    await Deno.writeTextFile(`${dir}/transcript.txt`, text);
}

async function demoSummarizeBatch(videoId: string) {
    const dir = `./test/data/${videoId}`
    const text = await Deno.readTextFile(`${dir}/transcript.txt`);
    const texts = await splitText(text);
    for (const line of texts) {
        const tokens = (await Tokenizer.tokenize(line)).length;
        console.log(`count: ${tokens}`)
    }
    const summaryBatch = await AIAgent.summarizeBatch(texts);
    await Deno.writeTextFile(`${dir}/summaryBatch.json`, JSON.stringify(summaryBatch, null, 2));
}

async function demoSummarizeFinal(videoId: string) {
    const raw = await Deno.readTextFile(`./test/data/${videoId}/summaryBatch.json`);
    const texts = JSON.parse(raw);
    return await AIAgent.summarize(texts.join("\n"), undefined, "detailed tldr;");
}

if (import.meta.main) {
    if (!AIAgent.OPENAI_API_KEY) throw new Error(`Missing OPENAI_API_KEY!`);
    const youtubeId = "pHJmmTivG1k"
    await demoDownloadTranscript(youtubeId);
    await demoSummarizeBatch(youtubeId);
    const out = await demoSummarizeFinal(youtubeId);
    console.log(`\n\nFinal Summary:\n${out}`)
}
