# Memory-Core Examples

This directory contains practical examples demonstrating how to use memory-core in real-world applications.

## Available Examples

### 1. Customer Support Bot (`customer-support.js`)

A comprehensive customer support chatbot that:
- Remembers customer issues and preferences
- Provides context-aware responses
- Tracks customer history and sentiment
- Extracts problems and preferences automatically

**Features:**
- Issue tracking and status updates
- Preference extraction and personalization
- Customer history analysis
- Severity assessment

**Usage:**
```bash
# Start memory-core first
npm run dev

# In another terminal, run the example
node examples/customer-support.js
```

**API Endpoints:**
- `POST /chat` - Main chat interface
- `GET /customer/:id/history` - Get customer history

**Example Request:**
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, I have an issue with my GPS not working",
    "customerId": "customer123",
    "sessionId": "session1"
  }'
```

### 2. Personal Assistant (`personal-assistant.js`)

An intelligent personal assistant that:
- Learns user preferences and habits
- Manages schedules and reminders
- Provides personalized recommendations
- Builds a comprehensive user profile

**Features:**
- Personal information extraction
- Habit and routine tracking
- Schedule management
- Preference-based recommendations
- Personality scoring

**Usage:**
```bash
# Start memory-core first
npm run dev

# In another terminal, run the example
node examples/personal-assistant.js
```

**API Endpoints:**
- `POST /interact` - Main interaction interface
- `GET /user/:id/profile` - Get user profile
- `POST /schedule` - Add schedule items

**Example Request:**
```bash
curl -X POST http://localhost:3001/interact \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, my name is Sarah and I prefer working out in the morning",
    "userId": "user123",
    "context": {"sessionId": "intro"}
  }'
```

## Running the Examples

### Prerequisites

1. **Start memory-core server:**
   ```bash
   cd memory-core
   npm install
   npm run dev
   ```

2. **Verify memory-core is running:**
   ```bash
   curl http://localhost:7401/health
   ```

### Running Individual Examples

Each example can be run independently:

```bash
# Customer Support Bot
node examples/customer-support.js

# Personal Assistant
node examples/personal-assistant.js
```

### Testing with Different Providers

You can test examples with different memory providers:

```bash
# Enhanced provider (recommended)
export MEMORY_PROVIDER=enhanced
npm run dev

# Dual-layer provider
export MEMORY_PROVIDER=dual-layer
npm run dev

# File provider
export MEMORY_PROVIDER=file
export MEMORY_FILE_PATH=./data/memories.json
npm run dev
```

## Example Workflows

### Customer Support Workflow

1. **Customer reports issue:**
   ```json
   {
     "message": "My GPS system is not working correctly",
     "customerId": "customer123"
   }
   ```

2. **Bot extracts and stores issue:**
   - Creates fact: "Customer reported issue: GPS system"
   - Sets high importance (0.9)
   - Tracks severity level

3. **Customer asks for status:**
   ```json
   {
     "message": "What's the status of my GPS issue?",
     "customerId": "customer123"
   }
   ```

4. **Bot provides context-aware response:**
   - Retrieves previous issue from memory
   - Provides personalized update

### Personal Assistant Workflow

1. **User shares personal info:**
   ```json
   {
     "message": "My name is Alex and I live in New York",
     "userId": "user123"
   }
   ```

2. **Assistant extracts and categorizes:**
   - Personal info: name, location
   - High importance for future personalization

3. **User shares preferences:**
   ```json
   {
     "message": "I prefer coffee over tea and I love jazz music",
     "userId": "user123"
   }
   ```

4. **Assistant learns preferences:**
   - Stores preferences with positive sentiment
   - Will use for future recommendations

5. **User requests recommendations:**
   ```json
   {
     "message": "Recommend a café for me",
     "userId": "user123"
   }
   ```

6. **Assistant provides personalized response:**
   - References coffee preference
   - Considers location (New York)

## Advanced Usage

### Custom Memory Types

Examples show how to use different memory types effectively:

```javascript
// Facts (objective information)
{
  memoryType: 'fact',
  text: 'Customer reported GPS issue',
  importance: 0.9
}

// Preferences (subjective likes/dislikes)
{
  memoryType: 'preference', 
  text: 'Likes: Italian food',
  importance: 0.7
}

// System responses
{
  memoryType: 'system',
  text: 'Assistant provided troubleshooting steps',
  importance: 0.4
}
```

### Metadata Usage

Rich metadata enables better memory retrieval:

```javascript
{
  metadata: {
    category: 'personal_info',
    type: 'birthday',
    extractedFrom: originalMessage,
    confidence: 0.9,
    sentiment: 'positive'
  }
}
```

### Context Building

Examples demonstrate effective context building:

```javascript
const context = await axios.post('/v1/memory/context', {
  query: userMessage,
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
```

## Performance Considerations

### Memory Provider Selection

- **In-Memory/File**: Good for simple examples, limited memory
- **Enhanced**: Recommended for production examples
- **Dual-Layer**: Best for complex scenarios with lots of data

### Optimization Tips

1. **Set appropriate importance scores:**
   ```javascript
   // High importance for critical info
   importance: 0.9  // Birthdays, appointments
   importance: 0.7  // Preferences, habits
   importance: 0.5  // General conversation
   ```

2. **Use relevant metadata:**
   ```javascript
   metadata: {
     category: 'schedule',     // Helps filtering
     eventType: 'meeting',     // Enables grouping
     priority: 'high'          // Influences ranking
   }
   ```

3. **Optimize context budgets:**
   ```javascript
   budget: {
     maxItems: 10,    // Fewer items for simple queries
     maxChars: 2000   // Adjust based on response complexity
   }
   ```

## Troubleshooting

### Common Issues

1. **"Connection refused" error:**
   - Ensure memory-core is running on port 7401
   - Check: `curl http://localhost:7401/health`

2. **Empty responses:**
   - Wait for observations to be ingested
   - Check memory provider configuration
   - Verify tenant/app/actor IDs match

3. **Poor memory retrieval:**
   - Lower similarity thresholds (enhanced provider)
   - Increase context budget
   - Check importance scores

### Debug Mode

Enable debug logging to troubleshoot:

```bash
export DEBUG=memory-core:*
export LOG_LEVEL=debug
npm run dev
```

### Memory Inspection

Check stored memories:

```bash
# Get all memories for a user
curl -X POST http://localhost:7401/v1/memory/context \
  -H "Content-Type: application/json" \
  -d '{
    "query": "all memories",
    "filters": {"actorId": "user123"},
    "budget": {"maxItems": 100}
  }'
```

## Contributing

To add a new example:

1. Create a new `.js` file in the `examples/` directory
2. Follow the existing pattern:
   - Import required dependencies
   - Create a class with memory integration
   - Add example usage and test function
   - Include proper error handling
3. Update this README with documentation
4. Test with different memory providers

### Example Template

```javascript
import express from 'express';
import axios from 'axios';

class ExampleApplication {
  constructor(memoryUrl = 'http://localhost:7401') {
    this.memoryUrl = memoryUrl;
    // Initialize your application
  }

  async storeMemory(data, userId) {
    // Store observations in memory-core
  }

  async getContext(query, userId) {
    // Retrieve relevant context
  }

  async generateResponse(query, context) {
    // Generate intelligent response
  }
}

export default ExampleApplication;
```