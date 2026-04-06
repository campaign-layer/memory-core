/**
 * Customer Support Bot Example
 * 
 * This example demonstrates how to use memory-core for a customer support chatbot
 * that remembers customer preferences, past issues, and conversation history.
 */

import express from 'express';
import axios from 'axios';

class CustomerSupportBot {
  constructor(memoryUrl = 'http://localhost:7401') {
    this.memoryUrl = memoryUrl;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  setupRoutes() {
    // Main chat endpoint
    this.app.post('/chat', async (req, res) => {
      try {
        const { message, customerId, sessionId } = req.body;
        
        if (!message || !customerId) {
          return res.status(400).json({ error: 'Message and customerId required' });
        }

        const response = await this.handleMessage(message, customerId, sessionId);
        res.json(response);
      } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get customer history
    this.app.get('/customer/:id/history', async (req, res) => {
      try {
        const { id } = req.params;
        const history = await this.getCustomerHistory(id);
        res.json(history);
      } catch (error) {
        console.error('History error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  async handleMessage(message, customerId, sessionId = 'default') {
    // 1. Store the customer's message
    await this.storeMessage(message, customerId, sessionId, 'customer');

    // 2. Get relevant context from memory
    const context = await this.getRelevantContext(message, customerId);

    // 3. Generate appropriate response based on context
    const botResponse = await this.generateResponse(message, context);

    // 4. Store the bot's response
    await this.storeMessage(botResponse, customerId, sessionId, 'bot');

    return {
      response: botResponse,
      context: {
        foundMemories: context.selectedMemories.length,
        processingTime: context.processingTime
      }
    };
  }

  async storeMessage(message, customerId, sessionId, role) {
    const observation = {
      tenantId: 'customer-support',
      appId: 'support-bot',
      actorId: customerId,
      threadId: sessionId,
      memoryType: role === 'customer' ? 'fact' : 'system',
      text: message,
      source: {
        sourceType: 'chat',
        sourceId: `${sessionId}-${Date.now()}`
      },
      metadata: {
        role,
        timestamp: new Date().toISOString(),
        channel: 'web-chat'
      },
      confidence: 0.9,
      importance: this.calculateImportance(message, role)
    };

    // Also extract any customer preferences or issues
    const additionalObservations = this.extractObservations(message, customerId, sessionId);
    
    const allObservations = [observation, ...additionalObservations];

    await axios.post(`${this.memoryUrl}/v1/memory/ingest`, {
      observations: allObservations
    });
  }

  calculateImportance(message, role) {
    const lowerMessage = message.toLowerCase();
    
    // High importance for issues, complaints, or feature requests
    if (role === 'customer' && (
      lowerMessage.includes('issue') ||
      lowerMessage.includes('problem') ||
      lowerMessage.includes('bug') ||
      lowerMessage.includes('error') ||
      lowerMessage.includes('complaint') ||
      lowerMessage.includes('frustrated')
    )) {
      return 0.9;
    }

    // Medium importance for preferences
    if (lowerMessage.includes('prefer') || 
        lowerMessage.includes('like') || 
        lowerMessage.includes('want')) {
      return 0.7;
    }

    return 0.5; // Default importance
  }

  extractObservations(message, customerId, sessionId) {
    const observations = [];
    const lowerMessage = message.toLowerCase();

    // Extract preferences
    const preferencePatterns = [
      /i prefer (.*)/i,
      /i like (.*)/i,
      /i want (.*)/i,
      /i need (.*)/i
    ];

    preferencePatterns.forEach(pattern => {
      const match = message.match(pattern);
      if (match) {
        observations.push({
          tenantId: 'customer-support',
          appId: 'support-bot',
          actorId: customerId,
          threadId: sessionId,
          memoryType: 'preference',
          text: `Customer prefers: ${match[1]}`,
          source: {
            sourceType: 'extracted_preference',
            sourceId: `pref-${Date.now()}`
          },
          metadata: {
            extractedFrom: message,
            type: 'preference',
            confidence: 0.8
          },
          confidence: 0.8,
          importance: 0.7
        });
      }
    });

    // Extract issues/problems
    const issuePatterns = [
      /issue with (.*)/i,
      /problem with (.*)/i,
      /(.*) is not working/i,
      /(.*) doesn't work/i
    ];

    issuePatterns.forEach(pattern => {
      const match = message.match(pattern);
      if (match) {
        observations.push({
          tenantId: 'customer-support',
          appId: 'support-bot',
          actorId: customerId,
          threadId: sessionId,
          memoryType: 'fact',
          text: `Customer reported issue: ${match[1]}`,
          source: {
            sourceType: 'extracted_issue',
            sourceId: `issue-${Date.now()}`
          },
          metadata: {
            extractedFrom: message,
            type: 'issue',
            severity: this.assessSeverity(message)
          },
          confidence: 0.85,
          importance: 0.9
        });
      }
    });

    return observations;
  }

  assessSeverity(message) {
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('urgent') || 
        lowerMessage.includes('critical') ||
        lowerMessage.includes('emergency')) {
      return 'high';
    }
    if (lowerMessage.includes('frustrated') || 
        lowerMessage.includes('annoying')) {
      return 'medium';
    }
    return 'low';
  }

  async getRelevantContext(message, customerId) {
    const response = await axios.post(`${this.memoryUrl}/v1/memory/context`, {
      query: message,
      filters: {
        tenantId: 'customer-support',
        appId: 'support-bot',
        actorId: customerId
      },
      budget: {
        maxItems: 10,
        maxChars: 2000
      }
    });

    return response.data;
  }

  async generateResponse(message, context) {
    const lowerMessage = message.toLowerCase();
    const memories = context.selectedMemories || [];

    // Greeting
    if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
      const pastIssues = memories.filter(m => 
        m.text.toLowerCase().includes('issue') || 
        m.text.toLowerCase().includes('problem')
      );
      
      if (pastIssues.length > 0) {
        return `Hello! I see you've contacted us before about some issues. How can I help you today? Is this related to your previous ${pastIssues[0].text.toLowerCase()}?`;
      }
      return "Hello! Welcome to customer support. How can I assist you today?";
    }

    // Issue reporting
    if (lowerMessage.includes('issue') || lowerMessage.includes('problem')) {
      const similarIssues = memories.filter(m => 
        m.text.toLowerCase().includes('issue') || 
        m.text.toLowerCase().includes('problem')
      );
      
      if (similarIssues.length > 0) {
        return `I understand you're experiencing an issue. I can see this might be related to a previous problem you had: "${similarIssues[0].text}". Let me help you troubleshoot this. Can you provide more details about what's happening?`;
      }
      return "I'm sorry to hear you're experiencing an issue. Can you please describe what's happening in detail so I can assist you better?";
    }

    // Status check
    if (lowerMessage.includes('status') || lowerMessage.includes('update')) {
      const recentIssues = memories
        .filter(m => m.text.toLowerCase().includes('issue'))
        .slice(0, 1);
      
      if (recentIssues.length > 0) {
        return `Let me check the status of your recent issue: "${recentIssues[0].text}". I'll look into this and provide you with an update shortly.`;
      }
      return "I'd be happy to check the status for you. Can you please specify which issue or request you'd like an update on?";
    }

    // Thank you
    if (lowerMessage.includes('thank')) {
      return "You're welcome! Is there anything else I can help you with today?";
    }

    // Preference-based responses
    const preferences = memories.filter(m => m.memoryType === 'preference');
    if (preferences.length > 0) {
      const pref = preferences[0].text;
      return `Based on your preferences (${pref}), I'd recommend... How does that sound?`;
    }

    // Default response with context
    if (memories.length > 0) {
      return `I understand your concern. Based on our previous conversations, I can see that we've discussed ${memories[0].text}. Let me help you with your current question.`;
    }

    return "I'd be happy to help you with that. Can you provide more details so I can assist you better?";
  }

  async getCustomerHistory(customerId) {
    const response = await axios.post(`${this.memoryUrl}/v1/memory/context`, {
      query: "conversation history",
      filters: {
        tenantId: 'customer-support',
        appId: 'support-bot',
        actorId: customerId
      },
      budget: {
        maxItems: 50,
        maxChars: 5000
      }
    });

    const memories = response.data.selectedMemories || [];
    
    // Organize by type
    const history = {
      issues: memories.filter(m => m.text.toLowerCase().includes('issue') || m.text.toLowerCase().includes('problem')),
      preferences: memories.filter(m => m.memoryType === 'preference'),
      conversations: memories.filter(m => m.source?.sourceType === 'chat'),
      summary: {
        totalMemories: memories.length,
        issueCount: memories.filter(m => m.text.toLowerCase().includes('issue')).length,
        preferenceCount: memories.filter(m => m.memoryType === 'preference').length
      }
    };

    return history;
  }

  start(port = 3000) {
    this.app.listen(port, () => {
      console.log(`Customer Support Bot running on port ${port}`);
      console.log('Example usage:');
      console.log(`curl -X POST http://localhost:${port}/chat -H "Content-Type: application/json" -d '{"message": "Hello, I have an issue with my order", "customerId": "customer123"}'`);
    });
  }
}

// Example usage
const bot = new CustomerSupportBot();

// Example test function
async function runExample() {
  console.log('Testing Customer Support Bot...\n');

  try {
    // Simulate customer conversation
    const customerId = 'customer123';
    
    console.log('1. Customer says hello');
    let response = await bot.handleMessage("Hello, I need help", customerId, 'session1');
    console.log('Bot:', response.response);
    
    console.log('\n2. Customer reports an issue');
    response = await bot.handleMessage("I have an issue with my GPS not working correctly", customerId, 'session1');
    console.log('Bot:', response.response);
    
    console.log('\n3. Customer expresses preference');
    response = await bot.handleMessage("I prefer email notifications over SMS", customerId, 'session1');
    console.log('Bot:', response.response);
    
    console.log('\n4. Customer asks for status');
    response = await bot.handleMessage("What's the status of my GPS issue?", customerId, 'session1');
    console.log('Bot:', response.response);
    
    console.log('\n5. Get customer history');
    const history = await bot.getCustomerHistory(customerId);
    console.log('Customer History Summary:', history.summary);
    
  } catch (error) {
    console.error('Error running example:', error.message);
  }
}

// Start the bot if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check if memory-core is running
  try {
    await axios.get('http://localhost:7401/health');
    console.log('Memory-core is running. Starting bot...');
    bot.start(3000);
    
    // Run example after a short delay
    setTimeout(runExample, 2000);
  } catch (error) {
    console.error('Please start memory-core first: npm run dev');
    console.log('Then run this example: node examples/customer-support.js');
  }
}

export default CustomerSupportBot;