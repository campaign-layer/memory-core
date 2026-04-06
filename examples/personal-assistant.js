/**
 * Personal Assistant Example
 * 
 * This example demonstrates how to use memory-core for a personal assistant
 * that remembers user preferences, schedules, habits, and personal information.
 */

import express from 'express';
import axios from 'axios';

class PersonalAssistant {
  constructor(memoryUrl = 'http://localhost:7401') {
    this.memoryUrl = memoryUrl;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  setupRoutes() {
    // Main interaction endpoint
    this.app.post('/interact', async (req, res) => {
      try {
        const { message, userId, context } = req.body;
        
        if (!message || !userId) {
          return res.status(400).json({ error: 'Message and userId required' });
        }

        const response = await this.handleInteraction(message, userId, context);
        res.json(response);
      } catch (error) {
        console.error('Interaction error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get user profile
    this.app.get('/user/:id/profile', async (req, res) => {
      try {
        const { id } = req.params;
        const profile = await this.getUserProfile(id);
        res.json(profile);
      } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Schedule management
    this.app.post('/schedule', async (req, res) => {
      try {
        const { userId, event, dateTime, description } = req.body;
        await this.addScheduleItem(userId, event, dateTime, description);
        res.json({ success: true, message: 'Event added to schedule' });
      } catch (error) {
        console.error('Schedule error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  async handleInteraction(message, userId, context = {}) {
    // 1. Store the user's message and extract insights
    await this.storeInteraction(message, userId, context);

    // 2. Get relevant context from memory
    const memoryContext = await this.getRelevantMemory(message, userId);

    // 3. Generate personalized response
    const assistantResponse = await this.generatePersonalizedResponse(message, memoryContext, context);

    // 4. Store the assistant's response
    await this.storeResponse(assistantResponse, userId, context);

    return {
      response: assistantResponse,
      suggestions: this.generateSuggestions(message, memoryContext),
      context: {
        foundMemories: memoryContext.selectedMemories.length,
        personalityInsights: this.extractPersonalityInsights(memoryContext.selectedMemories)
      }
    };
  }

  async storeInteraction(message, userId, context) {
    const baseObservation = {
      tenantId: 'personal-assistant',
      appId: 'assistant',
      actorId: userId,
      threadId: context.sessionId || 'default',
      text: message,
      source: {
        sourceType: 'user_interaction',
        sourceId: `interaction-${Date.now()}`
      },
      metadata: {
        timestamp: new Date().toISOString(),
        context: context.situational || 'general',
        deviceType: context.device || 'unknown',
        location: context.location
      },
      confidence: 0.9
    };

    const observations = [
      {
        ...baseObservation,
        memoryType: 'fact',
        importance: this.calculateMessageImportance(message)
      }
    ];

    // Extract additional observations
    observations.push(...this.extractPersonalInfo(message, userId, context));
    observations.push(...this.extractPreferences(message, userId, context));
    observations.push(...this.extractScheduleInfo(message, userId, context));
    observations.push(...this.extractHabits(message, userId, context));

    await axios.post(`${this.memoryUrl}/v1/memory/ingest`, {
      observations
    });
  }

  calculateMessageImportance(message) {
    const lowerMessage = message.toLowerCase();
    
    // High importance for personal info, appointments, important decisions
    if (lowerMessage.includes('birthday') ||
        lowerMessage.includes('appointment') ||
        lowerMessage.includes('meeting') ||
        lowerMessage.includes('anniversary') ||
        lowerMessage.includes('deadline') ||
        lowerMessage.includes('important') ||
        lowerMessage.includes('remember')) {
      return 0.95;
    }

    // Medium-high for preferences and goals
    if (lowerMessage.includes('prefer') ||
        lowerMessage.includes('goal') ||
        lowerMessage.includes('plan') ||
        lowerMessage.includes('want to') ||
        lowerMessage.includes('need to')) {
      return 0.8;
    }

    // Medium for habits and routines
    if (lowerMessage.includes('usually') ||
        lowerMessage.includes('always') ||
        lowerMessage.includes('often') ||
        lowerMessage.includes('routine')) {
      return 0.7;
    }

    return 0.6; // Default importance
  }

  extractPersonalInfo(message, userId, context) {
    const observations = [];
    const patterns = {
      name: /my name is (\w+)/i,
      birthday: /birthday.*(\w+ \d{1,2}(?:st|nd|rd|th)?)/i,
      age: /i am (\d+) years old/i,
      location: /i live in ([^,.]+)/i,
      job: /i work (?:as|at) ([^,.]+)/i,
      relationship: /(?:my|i have a) (husband|wife|partner|boyfriend|girlfriend)/i
    };

    Object.entries(patterns).forEach(([type, pattern]) => {
      const match = message.match(pattern);
      if (match) {
        observations.push({
          tenantId: 'personal-assistant',
          appId: 'assistant',
          actorId: userId,
          threadId: context.sessionId || 'default',
          memoryType: 'fact',
          text: `User's ${type}: ${match[1]}`,
          source: {
            sourceType: 'extracted_personal_info',
            sourceId: `personal-${type}-${Date.now()}`
          },
          metadata: {
            category: 'personal_info',
            type: type,
            extractedFrom: message,
            confidence: 0.9
          },
          confidence: 0.9,
          importance: 0.9
        });
      }
    });

    return observations;
  }

  extractPreferences(message, userId, context) {
    const observations = [];
    const preferencePatterns = [
      /i (?:prefer|like|love|enjoy) (.*?)(?:\.|,|$)/i,
      /i (?:don't like|hate|dislike) (.*?)(?:\.|,|$)/i,
      /my favorite (.*?) is (.*?)(?:\.|,|$)/i
    ];

    preferencePatterns.forEach((pattern, index) => {
      const match = message.match(pattern);
      if (match) {
        const isNegative = index === 1;
        const preference = match[1];
        const favoriteType = index === 2 ? match[1] : null;
        const favoriteItem = index === 2 ? match[2] : null;

        let preferenceText;
        if (favoriteType && favoriteItem) {
          preferenceText = `Favorite ${favoriteType}: ${favoriteItem}`;
        } else {
          preferenceText = `${isNegative ? 'Dislikes' : 'Likes'}: ${preference}`;
        }

        observations.push({
          tenantId: 'personal-assistant',
          appId: 'assistant',
          actorId: userId,
          threadId: context.sessionId || 'default',
          memoryType: 'preference',
          text: preferenceText,
          source: {
            sourceType: 'extracted_preference',
            sourceId: `pref-${Date.now()}`
          },
          metadata: {
            category: 'preference',
            sentiment: isNegative ? 'negative' : 'positive',
            extractedFrom: message
          },
          confidence: 0.85,
          importance: 0.7
        });
      }
    });

    return observations;
  }

  extractScheduleInfo(message, userId, context) {
    const observations = [];
    const schedulePatterns = [
      /(?:i have|schedule|book) (?:a |an )?(meeting|appointment|call|interview) (?:on|at) (.*?)(?:\.|,|$)/i,
      /(?:remind me to|i need to) (.*?) (?:on|at|by) (.*?)(?:\.|,|$)/i,
      /(?:deadline|due) (?:is |on )?(.*?)(?:\.|,|$)/i
    ];

    schedulePatterns.forEach(pattern => {
      const match = message.match(pattern);
      if (match) {
        const event = match[1];
        const timeInfo = match[2] || 'unspecified time';

        observations.push({
          tenantId: 'personal-assistant',
          appId: 'assistant',
          actorId: userId,
          threadId: context.sessionId || 'default',
          memoryType: 'fact',
          text: `Scheduled: ${event} at ${timeInfo}`,
          source: {
            sourceType: 'extracted_schedule',
            sourceId: `schedule-${Date.now()}`
          },
          metadata: {
            category: 'schedule',
            eventType: event,
            timeInfo: timeInfo,
            extractedFrom: message
          },
          confidence: 0.8,
          importance: 0.9
        });
      }
    });

    return observations;
  }

  extractHabits(message, userId, context) {
    const observations = [];
    const habitPatterns = [
      /i (?:usually|always|often|typically) (.*?)(?:\.|,|$)/i,
      /my routine (?:is|includes) (.*?)(?:\.|,|$)/i,
      /every (?:day|morning|evening|week) i (.*?)(?:\.|,|$)/i
    ];

    habitPatterns.forEach(pattern => {
      const match = message.match(pattern);
      if (match) {
        const habit = match[1];

        observations.push({
          tenantId: 'personal-assistant',
          appId: 'assistant',
          actorId: userId,
          threadId: context.sessionId || 'default',
          memoryType: 'preference',
          text: `Habit/Routine: ${habit}`,
          source: {
            sourceType: 'extracted_habit',
            sourceId: `habit-${Date.now()}`
          },
          metadata: {
            category: 'habit',
            extractedFrom: message
          },
          confidence: 0.75,
          importance: 0.6
        });
      }
    });

    return observations;
  }

  async storeResponse(response, userId, context) {
    const observation = {
      tenantId: 'personal-assistant',
      appId: 'assistant',
      actorId: userId,
      threadId: context.sessionId || 'default',
      memoryType: 'system',
      text: `Assistant response: ${response}`,
      source: {
        sourceType: 'assistant_response',
        sourceId: `response-${Date.now()}`
      },
      metadata: {
        timestamp: new Date().toISOString(),
        type: 'response'
      },
      confidence: 0.9,
      importance: 0.4
    };

    await axios.post(`${this.memoryUrl}/v1/memory/ingest`, {
      observations: [observation]
    });
  }

  async getRelevantMemory(message, userId) {
    const response = await axios.post(`${this.memoryUrl}/v1/memory/context`, {
      query: message,
      filters: {
        tenantId: 'personal-assistant',
        appId: 'assistant',
        actorId: userId
      },
      budget: {
        maxItems: 15,
        maxChars: 3000
      }
    });

    return response.data;
  }

  async generatePersonalizedResponse(message, memoryContext, context) {
    const memories = memoryContext.selectedMemories || [];
    const lowerMessage = message.toLowerCase();

    // Personal information queries
    if (lowerMessage.includes('what is my') || lowerMessage.includes('when is my')) {
      const personalInfo = memories.filter(m => 
        m.metadata?.category === 'personal_info' || 
        m.text.toLowerCase().includes('birthday') ||
        m.text.toLowerCase().includes('name')
      );
      
      if (personalInfo.length > 0) {
        return `Based on what you've told me: ${personalInfo[0].text}`;
      }
      return "I don't have that information yet. Could you share it with me?";
    }

    // Schedule queries
    if (lowerMessage.includes('what do i have') || 
        lowerMessage.includes('schedule') || 
        lowerMessage.includes('appointment')) {
      const scheduleItems = memories.filter(m => 
        m.metadata?.category === 'schedule' || 
        m.text.toLowerCase().includes('scheduled')
      );
      
      if (scheduleItems.length > 0) {
        const items = scheduleItems.map(item => item.text).join(', ');
        return `Here's what I found in your schedule: ${items}`;
      }
      return "I don't see any scheduled items. Would you like to add something?";
    }

    // Preference-based recommendations
    if (lowerMessage.includes('recommend') || 
        lowerMessage.includes('suggest') ||
        lowerMessage.includes('what should i')) {
      const preferences = memories.filter(m => m.memoryType === 'preference');
      
      if (preferences.length > 0) {
        const likes = preferences.filter(p => !p.text.toLowerCase().includes('dislikes'));
        if (likes.length > 0) {
          return `Based on your preferences (${likes[0].text}), I'd suggest looking for something similar. What specific area would you like recommendations for?`;
        }
      }
      return "I'd be happy to make recommendations. Can you tell me more about what you're looking for?";
    }

    // Habit and routine queries
    if (lowerMessage.includes('remind me') || lowerMessage.includes('routine')) {
      const habits = memories.filter(m => 
        m.metadata?.category === 'habit' || 
        m.text.toLowerCase().includes('routine')
      );
      
      if (habits.length > 0) {
        return `I remember your routine includes: ${habits[0].text}. I'll help you stay on track!`;
      }
      return "I'll help you build and maintain good routines. What would you like to be reminded about?";
    }

    // Goal setting and tracking
    if (lowerMessage.includes('goal') || lowerMessage.includes('achieve')) {
      const goals = memories.filter(m => m.text.toLowerCase().includes('goal'));
      
      if (goals.length > 0) {
        return `I see you're working on: ${goals[0].text}. How can I help you make progress?`;
      }
      return "I'd love to help you set and achieve your goals. What would you like to work on?";
    }

    // Greeting with personalization
    if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('good')) {
      const personalInfo = memories.filter(m => m.text.toLowerCase().includes('name'));
      const timeBasedGreeting = this.getTimeBasedGreeting();
      
      if (personalInfo.length > 0) {
        const name = personalInfo[0].text.split(':')[1]?.trim();
        return `${timeBasedGreeting}, ${name}! How can I assist you today?`;
      }
      return `${timeBasedGreeting}! How can I help you today?`;
    }

    // Default personalized response
    if (memories.length > 0) {
      const recentMemory = memories[0];
      return `I understand. Based on our previous conversations about ${recentMemory.text.toLowerCase()}, how can I help you today?`;
    }

    return "I'm here to help! The more you tell me about yourself, the better I can assist you with personalized recommendations and reminders.";
  }

  getTimeBasedGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  generateSuggestions(message, memoryContext) {
    const memories = memoryContext.selectedMemories || [];
    const suggestions = [];

    // Add contextual suggestions based on memory
    const preferences = memories.filter(m => m.memoryType === 'preference');
    const scheduleItems = memories.filter(m => m.metadata?.category === 'schedule');
    const habits = memories.filter(m => m.metadata?.category === 'habit');

    if (preferences.length > 0) {
      suggestions.push("Tell me more about your preferences");
      suggestions.push("Get personalized recommendations");
    }

    if (scheduleItems.length > 0) {
      suggestions.push("Review your schedule");
      suggestions.push("Add a new appointment");
    }

    if (habits.length > 0) {
      suggestions.push("Check on your routines");
      suggestions.push("Set a new habit reminder");
    }

    // Always available suggestions
    suggestions.push("Share personal information");
    suggestions.push("Set a goal");

    return suggestions.slice(0, 4); // Limit to 4 suggestions
  }

  extractPersonalityInsights(memories) {
    const insights = {
      preferenceCount: memories.filter(m => m.memoryType === 'preference').length,
      habitCount: memories.filter(m => m.metadata?.category === 'habit').length,
      scheduleItems: memories.filter(m => m.metadata?.category === 'schedule').length,
      personalInfoItems: memories.filter(m => m.metadata?.category === 'personal_info').length
    };

    return insights;
  }

  async getUserProfile(userId) {
    const response = await axios.post(`${this.memoryUrl}/v1/memory/context`, {
      query: "user profile information preferences habits schedule",
      filters: {
        tenantId: 'personal-assistant',
        appId: 'assistant',
        actorId: userId
      },
      budget: {
        maxItems: 100,
        maxChars: 10000
      }
    });

    const memories = response.data.selectedMemories || [];

    const profile = {
      personalInfo: memories.filter(m => m.metadata?.category === 'personal_info'),
      preferences: memories.filter(m => m.memoryType === 'preference'),
      schedule: memories.filter(m => m.metadata?.category === 'schedule'),
      habits: memories.filter(m => m.metadata?.category === 'habit'),
      summary: {
        totalMemories: memories.length,
        lastInteraction: memories.length > 0 ? memories[0].metadata?.timestamp : null,
        personalityScore: this.calculatePersonalityScore(memories)
      }
    };

    return profile;
  }

  calculatePersonalityScore(memories) {
    // Simple scoring based on interaction richness
    const preferenceCount = memories.filter(m => m.memoryType === 'preference').length;
    const personalInfoCount = memories.filter(m => m.metadata?.category === 'personal_info').length;
    const habitCount = memories.filter(m => m.metadata?.category === 'habit').length;
    
    return Math.min(100, (preferenceCount * 5) + (personalInfoCount * 10) + (habitCount * 3));
  }

  async addScheduleItem(userId, event, dateTime, description) {
    const observation = {
      tenantId: 'personal-assistant',
      appId: 'assistant',
      actorId: userId,
      threadId: 'schedule',
      memoryType: 'fact',
      text: `Scheduled: ${event} on ${dateTime}. ${description || ''}`,
      source: {
        sourceType: 'manual_schedule_entry',
        sourceId: `schedule-${Date.now()}`
      },
      metadata: {
        category: 'schedule',
        event: event,
        dateTime: dateTime,
        description: description,
        addedManually: true
      },
      confidence: 1.0,
      importance: 0.9
    };

    await axios.post(`${this.memoryUrl}/v1/memory/ingest`, {
      observations: [observation]
    });
  }

  start(port = 3001) {
    this.app.listen(port, () => {
      console.log(`Personal Assistant running on port ${port}`);
      console.log('Example usage:');
      console.log(`curl -X POST http://localhost:${port}/interact -H "Content-Type: application/json" -d '{"message": "Hello, my name is John and I prefer coffee over tea", "userId": "user123"}'`);
    });
  }
}

// Example usage
const assistant = new PersonalAssistant();

// Example test function
async function runExample() {
  console.log('Testing Personal Assistant...\n');

  try {
    const userId = 'user123';
    
    console.log('1. User introduces themselves');
    let response = await assistant.handleInteraction(
      "Hello, my name is Sarah and I live in San Francisco", 
      userId, 
      { sessionId: 'intro' }
    );
    console.log('Assistant:', response.response);
    console.log('Suggestions:', response.suggestions);
    
    console.log('\n2. User shares preferences');
    response = await assistant.handleInteraction(
      "I prefer working out in the morning and I love Italian food", 
      userId,
      { sessionId: 'preferences' }
    );
    console.log('Assistant:', response.response);
    
    console.log('\n3. User shares schedule');
    response = await assistant.handleInteraction(
      "I have a meeting with the design team on Friday at 2 PM", 
      userId,
      { sessionId: 'scheduling' }
    );
    console.log('Assistant:', response.response);
    
    console.log('\n4. User asks about schedule');
    response = await assistant.handleInteraction(
      "What do I have scheduled?", 
      userId,
      { sessionId: 'query' }
    );
    console.log('Assistant:', response.response);
    
    console.log('\n5. User asks for recommendations');
    response = await assistant.handleInteraction(
      "Can you recommend a restaurant for dinner?", 
      userId,
      { sessionId: 'recommendation' }
    );
    console.log('Assistant:', response.response);
    
    console.log('\n6. Get user profile');
    const profile = await assistant.getUserProfile(userId);
    console.log('User Profile Summary:', profile.summary);
    console.log('Personal Info:', profile.personalInfo.map(p => p.text));
    console.log('Preferences:', profile.preferences.map(p => p.text));
    
  } catch (error) {
    console.error('Error running example:', error.message);
  }
}

// Start the assistant if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check if memory-core is running
  try {
    await axios.get('http://localhost:7401/health');
    console.log('Memory-core is running. Starting assistant...');
    assistant.start(3001);
    
    // Run example after a short delay
    setTimeout(runExample, 2000);
  } catch (error) {
    console.error('Please start memory-core first: npm run dev');
    console.log('Then run this example: node examples/personal-assistant.js');
  }
}

export default PersonalAssistant;