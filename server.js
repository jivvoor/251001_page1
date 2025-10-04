const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");
const { Groq } = require("groq-sdk");
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage });


dotenv.config();
const { SUPABASE_KEY: supabaseKey, SUPABASE_URL: supabaseUrl } = process.env;
console.log("supabaseKey", supabaseKey);
console.log("supabaseUrl", supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "docs")));

app.get("/", (req, res) => {
  // 루트 경로 요청 시 index.html 파일을 제공합니다.
  res.sendFile(path.join(__dirname, "docs", "index.html"));
});

app.get("/plans", (req, res) => {
  // /plans 주소로 접속 시 index.html 파일을 제공합니다.
  res.sendFile(path.join(__dirname, "docs", "index.html"));
});

app.get("/api/plans", async (req, res) => {
  const { data, error } = await supabase.from("tour_plan").select("*");
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json(data);
});
app.post("/api/plans", upload.single("image"), async (req, res) => {
  try {
    const plan = req.body;
    // ai를 통해
    // npm install @google/genai
    if (req.file) {
    console.log("이미지 파일이 존재");
    // Date.now() -> 파일 중복을 막기 위해 시간을 나타내는 숫자를 앞에 접두사(prefix)로 작성
    const filename = `${Date.now()}_${req.file.originalname}`; // 확장자 .png 등을 알아서 붙여줌
    const { error: uploadError } = await supabase.storage
      .from("tour-images") // 버킷명.
      // buffer : 텍스트 형태로 나타낸 파일. mimetype : 파일의 속성. 형태.
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
      });
    if (uploadError) {
      console.error("이미지 업로드 실패", uploadError);
      return res.status(400).json({ error: uploadError.message });
    }
    // 여기까지 진행하면 server 파일 업로드 된 셈
    const { data: urlData } = supabase.storage
      .from("tour-images") // 버킷명
      .getPublicUrl(filename); // 생성파일 이름 -> 공개 URL

    plan.image_url = urlData.publicUrl; // 내가 업로드한 파일의 접속 링크 -> DB

    // 이미지 분석
    const analysis = await analyzeImage(req.file.buffer, req.file.mimetype);
    console.log(analysis);
    const { gemini, groq } = analysis;
    plan.purpose += `\n뒤는 목적과 관련된 사진에 대한 설명입니다. ${gemini}`;
    plan.purpose += `\n뒤는 목적과 관련된 사진에 대한 설명입니다. ${groq}`;
    } else {
        // 이미지가 없을 때
        console.log("감지된 이미지 파일 없음");
        const genImage = await generateImage(plan);
        plan.image_url = genImage;
        console.log("생성된 이미지 주소", genImage);
    }
    const result = await chaining(plan);
    plan.ai_suggestion = result;
    const { minBudget, maxBudget } = await ensemble(result);
    plan.ai_min_budget = minBudget;
    plan.ai_max_budget = maxBudget;

    const { error } = await supabase.from("tour_plan").insert(plan);
    if (error) {
      // Supabase 에러를 콘솔에 출력하고 클라이언트에게도 전달
      console.error("Supabase insert error:", error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json();
  } catch (e) {
    // chaining 함수 등에서 발생한 다른 에러 처리
    console.error("Error in POST /api/plans:", e);
    res.status(500).json({ error: "서버 내부 오류가 발생했습니다." });
  }
});

app.delete("/api/plans", async (req, res) => {
  const { planId } = req.body;
  const { data } = await supabase
    .from("tour_plan") // table
    .select("image_url")
    .eq("id", planId) // eq = equal = id가 planId
    .single(); // 한 개의 객체
  const { error } = await supabase.from("tour_plan").delete().eq("id", planId);
  if (error) {
    return res.status(400).json({ error: error.message });
    
  }
  res.status(204).json(); // noContent
});

app.listen(port, () => {
  console.log(`서버가 ${port}번 포트로 실행 중입니다.`);
});

async function chaining(plan) {
  const ai = new GoogleGenAI({}); // GEMINI_API_KEY 알아서 인식해줌
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
    [장소] ${plan.destination}
    [목적] ${plan.purpose}
    [인원수] ${plan.people_count}
    [시작일] ${plan.start_date}
    [종료일] ${plan.end_date}`,
    config: {
      // 형식을 구조화
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
          },
        },
        required: ["prompt"],
      },
      systemInstruction: [
        // { text: "제공받은 정보를 바탕으로 여행 계획을 짜되, 300자 이내로." },
        {
          text: `제공받은 정보를 바탕으로 최적의 여행 계획을 세우기 위한 프롬프트를 작성해줘. 응답은 JSON 형식으로 {"prompt": "프롬프트 내용"} 형식으로 작성해줘.`,
        },
      ],
      // structured output
    },
  });
  const { prompt } = JSON.parse(response.text);
  console.log("prompt", prompt);
  const response2 = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite", // 모델을 상대적으로 약한 모델로...
    contents: prompt,
    config: {
      systemInstruction: [
        {
          text: "프롬프트에 따라 작성하되, 300자 이내 plain text(no markdown or rich text)로.",
        },
      ],
    },
  });
  return response2.text;
}

async function ensemble(result) {
  const groq = new Groq(); // api key -> GROQ_API_KEY -> 환경변수가 알아서 인식
  const models = [
    "moonshotai/kimi-k2-instruct-0905",
    "openai/gpt-oss-120b",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
  ];
  const responses = await Promise.all(
    models.map(async (model) => {
      // https://console.groq.com/docs/structured-outputs
      const response = await groq.chat.completions.create({
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: `여행 경비 산출 전문가로, 주어진 여행 계획을 바탕으로 '원화 기준'의 숫자로만 작성된 예산을 작성하기. 응답은 JSON 형식으로 {"min_budget":"최소 예산", "max_budget": "최대 예산"}`,
          },
          {
            role: "user",
            content: result,
          },
        ],
        model,
      });
      console.log(response.choices[0].message.content);
      const { min_budget, max_budget } = JSON.parse(
        response.choices[0].message.content
      );
      return {
        min_budget: Number(min_budget),
        max_budget: Number(max_budget),
      };
    })
  );
  console.log(responses);
  return {
    minBudget: Math.min(...responses.map((v) => v.min_budget)),
    maxBudget: Math.max(...responses.map((v) => v.max_budget)),
  };
}


async function analyzeImage(buffer, mimeType) {
  // Gemini 호출
  console.log("Gemini Vision 분석 중");
  const ai = new GoogleGenAI({});
  const visionPrompt =
    "제공 받은 여행 관련 이미지를 분석하여, 어떠한 장소인지 어떠한 목적을 기대할 수 있는지를 한국어로 200자 이내로 적어주세요.";
  const b64 = buffer.toString("base64");
  const geminiResponse = await ai.models.generateContent({
    // https://ai.google.dev/gemini-api/docs/models?hl=ko
    model: "gemini-2.5-flash", // "gemini-2.5-flash-lite",
    contents: [
      {
        parts: [
          { text: visionPrompt },
          {
            inlineData: {
              data: b64,
              mimeType,
            },
          },
        ],
      },
    ],
  });
  // Groq 호출
  console.log("Groq Vision 분석 중");
  const groq = new Groq();
  const groqResponse = await groq.chat.completions.create({
    // https://console.groq.com/docs/vision
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    // meta-llama/llama-4-maverick-17b-128e-instruct
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: visionPrompt,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${b64}`,
            },
          },
        ],
      },
    ],
  });

  return {
    gemini: geminiResponse.text,
    groq: groqResponse.choices[0].message.content,
  };
}

async function generateImage(plan) {
  const ai = new GoogleGenAI({});
  const imagePrompt = `${plan.destination}의 아름다운 풍경 사진, ${plan.purpose}를 목적로 한 여행. ${plan.people_count}명의 여행.사실적인 사진 스타일`;
  console.log(imagePrompt);
  const response = await ai.models.generateContent({
    // https://ai.google.dev/gemini-api/docs/models?hl=ko#gemini-2.0-flash-image
    model: "gemini-2.0-flash-preview-image-generation",
    contents: imagePrompt,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });
  // console.log(response.candidates[0].content.parts);
  // const imageData = response.candidates[0].content.parts[0].inlineData.data;
  const parts = response.candidates[0].content.parts;
  const p0 = parts[0]?.inlineData?.data;
  const p1 = parts[1]?.inlineData?.data;
  const imageData = p0 || p1;
  const imageBuffer = Buffer.from(imageData, "base64");

  const filename = `gen_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from("tour-images")
    .upload(filename, imageBuffer, {
      contentType: "image/jpeg",
    });

  if (uploadError) {
    console.error("업로드 실패");
    return;
  }
  const { data: urlData } = supabase.storage
    .from("tour-images") // 버킷명
    .getPublicUrl(filename); // 생성파일 이름 -> 공개 URL
  return urlData.publicUrl; // 내가 업로드한 파일의 접속 링크 -> DB
}