const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware'); 
const axios = require('axios');


const { GoogleGenerativeAI } = require("@google/generative-ai");
// Check if API key exists
if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in environment variables');
  }
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
  
  
  
 
// GET /test-gemini - Test Gemini request through OpenRouter
router.get('/test-open-router', async (req, res) => {
  try {
    const apiKey = process.env.OPEN_ROUTER_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: 'OpenRouter API key not configured',
        error: {
          code: 'MISSING_API_KEY',
          details: 'OPEN_ROUTER_API_KEY is missing in .env'
        }
      });
    }

    // Call Gemini via OpenRouter
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: "deepseek/deepseek-v3.2",
        max_tokens: 256, 
        messages: [
          { role: "user", content: "Hello , say hi in one sentence." }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({
      success: true,
      message: "test successful",
      data: response.data
    });

  } catch (error) {
    console.error(" API Test Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "test failed",
      error: {
        code: "TEST_ERROR",
        details: error.response?.data || error.message
      }
    });
  }
});
 



router.post('/weather/reporter-summary', async (req, res) => {
  try {
    const { weatherData, forecastData, airQualityData, location, products } = req.body;

    // Validate required data
    if (!weatherData) {
      return res.status(400).json({
        success: false,
        message: 'Weather data is required',
        error: { code: 'MISSING_WEATHER_DATA' }
      });
    }

    const apiKey = process.env.OPEN_ROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: 'OpenRouter API key not configured',
        error: {
          code: 'MISSING_API_KEY',
          details: 'OPEN_ROUTER_API_KEY is missing in .env'
        }
      });
    }

    // Handle products - if not provided or empty array
    let productList = [];
    let hasProducts = false;
    
    if (products && Array.isArray(products) && products.length > 0) {
      // Limit to top 5 products to avoid overly long prompts
      const limitedProducts = products.slice(0, 5);
      
      productList = limitedProducts.map(product => {
        if (typeof product === 'string') {
          // Handle format "129: Corn" or just "Corn"
          const parts = product.split(':');
          return parts.length > 1 ? parts[1].trim() : product.trim();
        }
        return String(product).trim();
      }).filter(product => product.length > 0); // Remove any empty strings
      
      hasProducts = productList.length > 0;
      
      // Log if we truncated the list
      if (products.length > 5) {
        console.log(`Truncated product list from ${products.length} to 5 items`);
      }
    }

    // Build product-specific part of the prompt
    let productsPrompt = '';
    if (hasProducts) {
      if (productList.length === 1) {
        productsPrompt = `Farm is growing: ${productList[0]}. `;
      } else if (productList.length <= 3) {
        productsPrompt = `Farm is growing: ${productList.join(', ')}. `;
      } else {
        productsPrompt = `Farm is growing multiple crops including ${productList.slice(0, 3).join(', ')}${productList.length > 3 ? ` and ${productList.length - 3} more` : ''}. `;
      }
    }

   // Farm-focused weather prompt - UPDATED FOR PERSONAL ADDRESS
const prompt = `You are an agricultural weather advisor speaking directly to a Filipino farmer. Based on the following weather data, create a practical, concise weather summary (2-3 sentences max) specifically for THIS FARMER'S operations. 

IMPORTANT: 
1. Write in TAGLISH (mix of Tagalog and English) that Filipino farmers can easily understand.
2. Speak DIRECTLY to the farmer using "IKAW/MO/IYO" (singular) - NOT "kayo/inyo" (plural).
3. Use the farmer's name if provided, otherwise use direct singular address like "Ka-Farmer" or just direct conversational style.
4. Be personal as if giving advice to one specific farmer.

Current Weather:
- Temperature: ${weatherData.temperature}°C (feels like ${weatherData.feelsLike}°C)
- Condition: ${weatherData.description}
- Humidity: ${weatherData.humidity}%
- Wind Speed: ${weatherData.windSpeed} m/s
- Visibility: ${weatherData.visibility / 1000} km
- Clouds: ${weatherData.clouds}%
${weatherData.rain1h ? `- Rainfall: ${weatherData.rain1h} mm in last hour` : ''}

${airQualityData ? `Air Quality: ${airQualityData.quality} (AQI ${airQualityData.aqi})` : ''}

${forecastData && forecastData.length > 0 ? `
Today's Forecast:
- High: ${forecastData[0].tempMax}°C, Low: ${forecastData[0].tempMin}°C
- Condition: ${forecastData[0].description}

Tomorrow:
- High: ${forecastData[1]?.tempMax}°C, Low: ${forecastData[1]?.tempMin}°C
- Condition: ${forecastData[1]?.description}
` : ''}

${productsPrompt}

Create a brief agricultural weather advisory IN TAGLISH speaking DIRECTLY TO THE FARMER. Focus on:
1. Field work suitability for YOUR farm (spraying, planting, harvesting) - Pwede ka bang mag-field work ngayon?
2. Crop protection advice for YOUR crops - Mga babala para sa MGA TANIM MO
3. Livestock considerations for YOUR animals - Para sa MGA ALAGA MO
4. Irrigation needs for YOUR fields - Kailangan mo bang mag-dilig?
5. Soil moisture implications for YOUR land - Tungkol sa LUPA MO

${hasProducts ? `Provide advice tailored specifically to YOUR ${productList.length === 1 ? 'crop' : 'crops'} IN TAGLISH.` : 'Provide personal farm weather advice suitable for your mixed farming operations IN TAGLISH.'}

Speak directly to the farmer using "ikaw/mo/iyo" (singular). Be practical, specific, and personal as if advising one farmer about their own farm. Use common Filipino farming terms.`;

    // List of models in priority order
    const models = [
      "google/gemini-2.5-flash",
      "google/openai/gpt-4o-mini",
      "deepseek/deepseek-v3.2"
    ];

    let summary = '';
    let lastError = null;

    for (const model of models) {
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 280
          },
          {
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            }
          }
        );

        summary = response.data.choices[0]?.message?.content || '';
        if (summary) break; // stop on first success

      } catch (error) {
        const errData = error.response?.data;
        // If quota error (402), skip to next model immediately
        if (errData?.error?.code === 402) {
          console.warn(`Quota exceeded for model ${model}, trying next model...`);
          lastError = errData;
          continue;
        }
        // For other errors, log and try next model
        console.warn(`Error with model ${model}:`, errData || error.message);
        lastError = errData || error;
      }
    }

    if (!summary) {
      return res.status(500).json({
        success: false,
        message: 'All models failed or are out of quota',
        error: lastError
      });
    }

    res.status(200).json({
      success: true,
      summary: summary.trim(),
      message: '✅ May weather summary na para sa farm mo! Ito na ang advice para sa araw na ito.',
      metadata: {
        hasProducts: hasProducts,
        productCount: productList.length,
        products: hasProducts ? productList : undefined,
        note: hasProducts ? `Kasama sa advice ang mga tanim mo: ${productList.join(', ')}` : 'General farm advice lang muna'
      }
    });

  } catch (error) {
    console.error('❌ Failed to generate farm weather summary:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to generate farm weather summary',
      error: error.response?.data || error.message
    });
  }
});

 
 
router.get('/chatbot/test', async (req, res) => {
  try {
    console.log('🧪 Testing Gemini API...');

 

    const result = await model.generateContent('Say "Hello from Gemini!"');
    const response = await result.response;
    const text = response.text();

    console.log('✅ Gemini test successful:', text);

    res.status(200).json({
      success: true,
      message: 'Gemini is working!',
      response: text
    });
  } catch (error) {
    console.error('❌ Gemini test failed:', error);
    res.status(500).json({
      success: false,
      message: 'Gemini test failed',
      error: error.message
    });
  }
});



// Updated cleanup function that handles the actual patterns in your response
function cleanupResponseText(text) {
    return text
      // Remove markdown bold markers
      .replace(/\*\*/g, '')
      // Remove numbered section headers (e.g., "1. Pangkalahatang Pagsusuri:")
      .replace(/^\d+\.\s+[^:\n]+:\s*$/gm, '')
      // Remove numbered section headers inline (e.g., "**1. Pangkalahatang Pagsusuri:**")
      .replace(/\d+\.\s+[^:\n]+:\s*/g, '')
      // Remove bullet points with asterisks, keep the content
      .replace(/^\s*\*\s+/gm, '')
      // Remove nested bullet points (with indentation)
      .replace(/^\s+\*\s+/gm, '')
      // Clean up multiple newlines (more than 2)
      .replace(/\n{3,}/g, '\n\n')
      // Remove leading/trailing whitespace from each line
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .trim();
  }
  
  // Alternative: Keep some structure but make it cleaner
  function cleanupWithStructure(text) {
    return text
      // Remove markdown bold
      .replace(/\*\*/g, '')
      // Convert numbered headers to plain text
      .replace(/^(\d+)\.\s+([^:\n]+):\s*$/gm, '$2')
      // Remove bullet asterisks but keep content
      .replace(/^\s*\*\s+/gm, '• ')
      // Clean nested bullets
      .replace(/^\s+\*\s+/gm, '  • ')
      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  
  // Implementation in your router code:
  
  router.post('/suitability/suggestions', async (req, res) => {
    try {
      const { crop, deficiencies } = req.body;
  
      if (!crop || !deficiencies || Object.keys(deficiencies).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Kailangan ang crop at deficiencies'
        });
      }
  
      // Build deficiency details
      const parameterNames = {
        'soil_ph': 'Soil pH',
        'fertility_ec': 'Soil Fertility (EC)',
        'sunlight': 'Sunlight Exposure',
        'soil_temp': 'Soil Temperature',
        'humidity': 'Humidity',
        'soil_moisture': 'Soil Moisture'
      };
  
      const deficiencyDetails = Object.entries(deficiencies)
        .map(([param, details]) => {
          const paramName = parameterNames[param] || param;
          return `• ${paramName}: Kasalukuyan ${details.current} (Ideal na saklaw: ${details.ideal_min}-${details.ideal_max})`;
        })
        .join('\n');
  
      // Updated prompt - ask for cleaner output from the start
      const prompt = `Ikaw ay isang eksperto sa agrikultura na nagbibigay ng rekomendasyon para sa pagtatanim ng ${crop}.
  
  MGA KULANG NA PARAMETER:
  ${deficiencyDetails}
  
  Magbigay ng detalyadong rekomendasyon sa natural na Filipino. Huwag gumamit ng mga numero, asterisks, o markdown formatting. Isulat ito bilang natural na talata na madaling basahin.
  
  Isama ang sumusunod:
  - Maikling pagsusuri sa kalagayan ng taniman
  - Para sa bawat kulang na parameter: praktikal na aksyon, rekomendadong sukat, at timeline
  - Pinagsamang rekomendasyon na nakatuon sa lupa, kapaligiran, pataba, at best practices
  - Tatlong madaling sundin na hakbang
  - Maikling panghuling payo
  
  Gumamit ng simple at direktang Filipino. Tumutok sa praktikal at abot-kayang solusyon.`;
  
      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
  
      console.log(`🤖 Generating recommendations for ${crop}...`);
  
      let primaryModelSuccess = false;
      let fullResponse = '';
      let chunkCount = 0;
  
      try {
        const result = await model.generateContentStream(prompt);
  
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            fullResponse += text;
            
            // Clean the chunk before sending
            const cleanedChunk = cleanupResponseText(text);
            chunkCount++;
  
            // Send cleaned chunk to client
            res.write(`data: ${JSON.stringify({
              chunk: cleanedChunk,
              done: false
            })}\n\n`);
  
            if (chunkCount % 10 === 0) {
              console.log(`📦 Sent ${chunkCount} chunks...`);
            }
          }
        }
  
        primaryModelSuccess = true;
        console.log(`✅ Completed streaming ${chunkCount} chunks from primary model`);
  
      } catch (primaryError) {
        console.error(`❌ Primary model failed:`, primaryError.message);
        
        // Fallback to OpenRouter (same cleanup logic)
        const openRouterApiKey = process.env.OPEN_ROUTER_API_KEY;
        if (!openRouterApiKey) {
          throw new Error('OPEN_ROUTER_API_KEY not configured');
        }
  
        const openRouterModels = [ 
          "google/gemini-2.5-flash",
          "google/openai/gpt-4o-mini",
          "deepseek/deepseek-v3.2"
        ];
  
        let openRouterSuccess = false;
        let lastError = null;
  
        for (const model of openRouterModels) {
          try {
            console.log(`🔄 Trying OpenRouter model: ${model}`);
            
            const response = await axios.post(
              'https://openrouter.ai/api/v1/chat/completions',
              {
                model: model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 2048,
                stream: true
              },
              {
                headers: {
                  "Authorization": `Bearer ${openRouterApiKey}`,
                  "Content-Type": "application/json",
                  "HTTP-Referer": req.headers.origin || "https://yourdomain.com",
                  "X-Title": "FarmSmart AI"
                },
                responseType: 'stream'
              }
            );
  
            const stream = response.data;
            openRouterSuccess = true;
  
            stream.on('data', (chunk) => {
              try {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                    const data = JSON.parse(line.substring(6));
                    if (data.choices?.[0]?.delta?.content) {
                      const text = data.choices[0].delta.content;
                      fullResponse += text;
                      
                      // Clean the chunk
                      const cleanedChunk = cleanupResponseText(text);
                      chunkCount++;
  
                      res.write(`data: ${JSON.stringify({
                        chunk: cleanedChunk,
                        done: false
                      })}\n\n`);
                    }
                  }
                }
              } catch (parseError) {
                console.warn('Parse error in stream:', parseError.message);
              }
            });
  
            stream.on('end', () => {
              console.log(`✅ Completed streaming from OpenRouter (${model})`);
              
              // Clean the full response before sending
              const cleanedFullResponse = cleanupResponseText(fullResponse);
              
              res.write(`data: ${JSON.stringify({
                chunk: '',
                done: true,
                fullResponse: cleanedFullResponse
              })}\n\n`);
              res.end();
            });
  
            stream.on('error', (error) => {
              console.error(`Stream error with model ${model}:`, error.message);
              lastError = error;
              openRouterSuccess = false;
            });
  
            await new Promise((resolve, reject) => {
              stream.on('end', resolve);
              stream.on('error', reject);
            });
  
            if (openRouterSuccess) break;
  
          } catch (openRouterError) {
            const errData = openRouterError.response?.data;
            if (errData?.error?.code === 402) {
              console.warn(`Quota exceeded for model ${model}, trying next...`);
              lastError = errData;
              continue;
            }
            console.warn(`Error with OpenRouter model ${model}:`, errData || openRouterError.message);
            lastError = errData || openRouterError;
          }
        }
  
        if (!openRouterSuccess) {
          throw new Error(`All models failed. Last error: ${lastError?.message || 'Unknown error'}`);
        }
      }
  
      // If primary model was successful, send cleaned final message
      if (primaryModelSuccess) {
        const cleanedFullResponse = cleanupResponseText(fullResponse);
        
        res.write(`data: ${JSON.stringify({
          chunk: '',
          done: true,
          fullResponse: cleanedFullResponse
        })}\n\n`);
        res.end();
      }
  
    } catch (error) {
      console.error(`❌ Error generating suggestions:`, error);
  
      try {
        res.write(`data: ${JSON.stringify({
          error: true,
          message: 'May problema sa pagbuo ng mga rekomendasyon. Pakisubukan muli.',
          errorDetails: error.message
        })}\n\n`);
        res.end();
      } catch (writeError) {
        console.error('❌ Could not write error response:', writeError);
      }
    }
  }); 
  const SYSTEM_PROMPT = `
  You are AgriBot, an agricultural assistant for Filipino farmers. Your responses should be in clear, simple Tagalog/Filipino.
  
  ## IMPORTANT FORMATTING RULES:
  1. ALWAYS end EVERY response with exactly 4 follow-up questions
  2. Use this EXACT format for follow-up questions:
     [FOLLOW_UP_QUESTIONS]
     1. First question here
     2. Second question here
     3. Third question here
     4. Fourth question here
     [/FOLLOW_UP_QUESTIONS]
  
  3. Do NOT use bullet points (*), dashes (-), or other markers
  4. Use ONLY numbers (1., 2., 3., 4.)
  5. The follow-up questions should be relevant to the current response
  
  ## Response Structure:
  1. First, answer the user's question concisely
  2. Then add exactly 4 follow-up questions in the format above
  3. Do NOT include any text after the [/FOLLOW_UP_QUESTIONS] marker
  
  Example of correct format:
  [Your response to the user's question goes here...]
  
  [FOLLOW_UP_QUESTIONS]
  1. Paano ko masusukat ang tamang temperatura para sa aking pananim?
  2. Ano ang mga senyales ng stress sa init sa mga halaman?
  3. May mga pananim bang mas matibay sa mainit na panahon?
  4. Paano ko mapoprotektahan ang aking pananim sa sobrang lamig?
  [/FOLLOW_UP_QUESTIONS]
  
  Remember: EVERY response MUST include this format. No exceptions.
  `; 
  
  router.post('/chatbot/message', authenticate, async (req, res) => {
    const userId = req.user.firebaseUid;
  
    try {
      const { message } = req.body;
  
      if (!message?.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Kailangan ng mensahe'
        });
      }
  
      // SYSTEM_PROMPT should be defined elsewhere in your code
      const systemPrompt = SYSTEM_PROMPT || `Ikaw ay isang AI assistant para sa FarmSmart, 
      isang smart farming application. Ikaw ay:
      1. Magalang at helpful
      2. Mag-focus sa agricultural advice
      3. Gumamit ng Tagalog at simple English
      4. Magbigay ng praktikal na payo`;
  
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
  
      let fullResponse = '';
      let chunkCount = 0;
      let modelUsed = 'unknown';
      let usedFallback = false;
  
      // Try primary model first (Gemini)
      try {
        console.log(`🤖 Trying primary model for user ${userId}`);
        
        // Intentionally wrong model name to trigger error
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash-lite', // This should fail
          systemInstruction: systemPrompt,
        });
  
        const result = await model.generateContentStream(message);
        modelUsed = 'gemini-2.5-flash-lite';
        
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            fullResponse += text;
            chunkCount++;
            res.write(`data: ${JSON.stringify({ chunk: text, done: false })}\n\n`);
          }
        }
  
        console.log(`✅ Successfully streamed ${chunkCount} chunks from primary model (${modelUsed})`);
  
      } catch (primaryError) {
        console.error(`❌ Primary model failed for user ${userId}:`, primaryError.message);
        usedFallback = true;
        
        // Fallback to OpenRouter
        console.log(`🔄 Falling back to OpenRouter for user ${userId}...`);
        
        const openRouterApiKey = process.env.OPEN_ROUTER_API_KEY;
        if (!openRouterApiKey) {
          throw new Error('OPEN_ROUTER_API_KEY not configured');
        }
  
        // List of models in priority order
        const openRouterModels = [
          "google/gemini-2.5-flash",
          "google/openai/gpt-4o-mini",
          "deepseek/deepseek-v3.2"
        ];
  
        let openRouterSuccess = false;
        let lastError = null;
  
        for (const modelName of openRouterModels) {
          try {
            console.log(`🔄 Trying OpenRouter model: ${modelName} for user ${userId}`);
            
            const response = await axios.post(
              'https://openrouter.ai/api/v1/chat/completions',
              {
                model: modelName,
                messages: [
                  {
                    role: "system",
                    content: systemPrompt
                  },
                  {
                    role: "user",
                    content: message
                  }
                ],
                max_tokens: 1024,
                stream: true,
                temperature: 0.7
              },
              {
                headers: {
                  "Authorization": `Bearer ${openRouterApiKey}`,
                  "Content-Type": "application/json",
                  "HTTP-Referer": req.headers.origin || "https://yourdomain.com",
                  "X-Title": "FarmSmart AI Chatbot"
                },
                responseType: 'stream'
              }
            );
  
            const stream = response.data;
            openRouterSuccess = true;
            modelUsed = `openrouter:${modelName}`;
  
            // Process the stream
            await new Promise((resolve, reject) => {
              stream.on('data', (chunk) => {
                try {
                  const lines = chunk.toString().split('\n');
                  for (const line of lines) {
                    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                      const data = JSON.parse(line.substring(6));
                      if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                        const text = data.choices[0].delta.content;
                        fullResponse += text;
                        chunkCount++;
                        res.write(`data: ${JSON.stringify({ 
                          chunk: text, 
                          done: false,
                          fallback: usedFallback,
                          model: modelName 
                        })}\n\n`);
                      }
                    }
                  }
                } catch (parseError) {
                  console.warn('Parse error in OpenRouter stream:', parseError.message);
                }
              });
  
              stream.on('end', () => {
                console.log(`✅ Completed streaming from OpenRouter (${modelName})`);
                resolve();
              });
  
              stream.on('error', (error) => {
                console.error(`Stream error with model ${modelName}:`, error.message);
                reject(error);
              });
            });
  
            if (openRouterSuccess) {
              console.log(`✓ Fallback successful with model: ${modelName}`);
              break; // Exit loop if successful
            }
  
          } catch (openRouterError) {
            const errData = openRouterError.response?.data;
            
            // Handle quota errors specifically
            if (errData?.error?.code === 402) {
              console.warn(`❌ Quota exceeded for model ${modelName}, trying next model...`);
              lastError = errData;
              continue;
            }
            
            // Handle rate limiting
            if (errData?.error?.code === 429) {
              console.warn(`❌ Rate limited for model ${modelName}, trying next model...`);
              lastError = errData;
              continue;
            }
            
            console.warn(`❌ Error with OpenRouter model ${modelName}:`, errData?.error?.message || openRouterError.message);
            lastError = errData || openRouterError;
          }
        }
  
        if (!openRouterSuccess) {
          throw new Error(`All OpenRouter models failed. Last error: ${lastError?.message || 'Unknown error'}`);
        }
      }
  
      // Extract suggestions from response (if your function exists)
      let extracted = { response: fullResponse, suggestions: [] };
      if (typeof extractSuggestionsFromResponse === 'function') {
        try {
          extracted = extractSuggestionsFromResponse(fullResponse);
        } catch (extractError) {
          console.warn('Failed to extract suggestions:', extractError.message);
          extracted.response = fullResponse;
        }
      }
  
      // Send final message with correct model info
      console.log(`📊 Final stats: ${chunkCount} chunks, model: ${modelUsed}, usedFallback: ${usedFallback}`);
      
      res.write(`data: ${JSON.stringify({
        chunk: '',
        done: true,
        fullResponse: extracted.response,
        suggestions: extracted.suggestions,
        modelUsed: modelUsed,
        usedFallback: usedFallback,
        chunkCount: chunkCount
      })}\n\n`);
  
      res.end();
  
    } catch (error) {
      console.error(`❌ Error for user ${userId}:`, error);
      
      try {
        // Send error message via SSE
        res.write(`data: ${JSON.stringify({
          error: true,
          message: 'Paumanhin, may problema sa pagkonekta sa AI service. Pakisubukan muli sandali.',
          errorDetails: process.env.NODE_ENV === 'development' ? error.message : undefined
        })}\n\n`);
        res.end();
      } catch (writeError) {
        // If we can't write to the stream, end it
        try {
          res.end();
        } catch (endError) {
          console.error('Failed to end response:', endError);
        }
      }
    }
  }); 
  function extractSuggestionsFromResponse(fullResponse) {
    console.log('🔍 Extracting suggestions from response...');
    console.log('📏 Response length:', fullResponse.length);
    
    const startMarker = '[FOLLOW_UP_QUESTIONS]';
    const endMarker = '[/FOLLOW_UP_QUESTIONS]';
    
    // Try to find markers first
    if (fullResponse.includes(startMarker) && fullResponse.includes(endMarker)) {
      const startIndex = fullResponse.indexOf(startMarker);
      const endIndex = fullResponse.indexOf(endMarker);
  
      const cleanResponse = fullResponse.substring(0, startIndex).trim();
      const suggestionsSection = fullResponse
        .substring(startIndex + startMarker.length, endIndex)
        .trim();
      
      console.log(`📋 Suggestions section extracted:`, suggestionsSection);
      
      const suggestions = suggestionsSection
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^[-*•]\s*|^\d+\.\s*/, '').trim())
        .filter(line => line.length > 5)
        .slice(0, 4);
      
      console.log(`✅ Extracted ${suggestions.length} suggestions with markers`);
      
      if (suggestions.length >= 4) {
        return {
          response: cleanResponse,
          suggestions: suggestions
        };
      }
    }
    
    // Fallback: Try to extract numbered questions from the end of response
    console.log('⚠️ Markers not found, trying regex fallback...');
    
    // Look for numbered lines (1., 2., 3., 4.) in the last part of response
    const lines = fullResponse.split('\n');
    const numberedLines = [];
    
    // Search from the end backwards
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i].trim();
      // Match lines starting with "1.", "2.", "3.", "4."
      const match = line.match(/^(\d+)\.\s*(.+)$/);
      if (match && match[2].length > 10) {
        numberedLines.unshift({
          number: parseInt(match[1]),
          text: match[2].trim()
        });
      }
    }
    
    // If we found 4 consecutive numbered items (1, 2, 3, 4), use them
    if (numberedLines.length >= 4) {
      const consecutiveQuestions = [];
      for (let i = 0; i < numberedLines.length - 3; i++) {
        if (numberedLines[i].number === 1 &&
            numberedLines[i + 1].number === 2 &&
            numberedLines[i + 2].number === 3 &&
            numberedLines[i + 3].number === 4) {
          consecutiveQuestions.push(
            numberedLines[i].text,
            numberedLines[i + 1].text,
            numberedLines[i + 2].text,
            numberedLines[i + 3].text
          );
          break;
        }
      }
      
      if (consecutiveQuestions.length === 4) {
        console.log(`✅ Found 4 questions using regex fallback`);
        
        // Remove the questions from the response
        let cleanResponse = fullResponse;
        consecutiveQuestions.forEach(q => {
          const qPattern = new RegExp(`\\d+\\.\\s*${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
          cleanResponse = cleanResponse.replace(qPattern, '');
        });
        
        return {
          response: cleanResponse.trim(),
          suggestions: consecutiveQuestions
        };
      }
    }
    
    console.log(`❌ Could not extract questions, using fallback`);
    
    return {
      response: fullResponse,
      suggestions: getFallbackSuggestions()
    };
  }
  
  function getFallbackSuggestions() {
    return [
      'Maaari mo bang ipaliwanag pa?',
      'Ano ang mga benepisyo?',
      'May iba pa bang paraan?',
      'Paano ako magsisimula?'
    ];
  } 
  function getFallbackSuggestions() {
    return [
      'Maaari mo bang ipaliwanag pa?',
      'Ano ang mga benepisyo?',
      'May iba pa bang paraan?',
      'Paano ako magsisimula?'
    ];
  } 
  // Test endpoint to verify Gemini works
  router.get('/chatbot/test', async (req, res) => {
    try {
      console.log('🧪 Testing Gemini API...');
   
  
      const result = await model.generateContent('Say "Hello from Gemini!"');
      const response = await result.response;
      const text = response.text();
  
      console.log('✅ Gemini test successful:', text);
  
      res.status(200).json({
        success: true,
        message: 'Gemini is working!',
        response: text
      });
    } catch (error) {
      console.error('❌ Gemini test failed:', error);
      res.status(500).json({
        success: false,
        message: 'Gemini test failed',
        error: error.message
      });
    }
  }); 
  
  router.get('/test-gemini', async (req, res) => {
    try {
      
  
      const result = await model.generateContent("Say hello! This is a test.");
      const text = result?.response?.text?.() || "(No text returned)";
  
      return res.status(200).json({
        success: true,
        message: "Gemini Flash 2.0 endpoint works!",
        response: text
      });
  
    } catch (error) {
      console.error("Gemini Test Error:", error);
  
      // Attempt to extract structured API error JSON if available
      let extracted = {};
      try {
        // Sometimes GoogleError includes JSON inside the message string
        const jsonMatch = error.message?.match(/\{[\s\S]*\}$/);
        if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
      } catch (_) {}
  
      // Detect quota/rate limits
      const is429 =
        error.status === 429 ||
        error.message?.includes("429") ||
        extracted?.error?.code === 429;
  
      const quotaInfo =
        extracted?.error?.details ||
        extracted?.details ||
        null;
  
      return res.status(is429 ? 429 : 500).json({
        success: false,
        message: "Error calling Gemini API",
        error: {
          type: error.name,
          message: error.message,
          status: error.status || null,
          quota: quotaInfo,
          stack: process.env.NODE_ENV === "development" ? error.stack : undefined
        }
      });
    }
  });
  



module.exports = router;
