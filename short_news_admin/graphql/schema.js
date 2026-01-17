const { gql } = require('apollo-server-express');

const typeDefs = gql`
  type Comment {
    id: ID!
    text: String!
    userId: String!
    userName: String
    createdAt: String!
  }

  type UserInteraction {
    userId: String!
    userName: String!
    userEmail: String
    comment: String
    timestamp: String!
  }

  type News {
    id: ID!
    title: String!
    content: String!
    imageUrl: String
    videoUrl: String
    mediaUrl: String
    mediaType: String
    thumbnailUrl: String
    category: String!
    location: String
    publishedAt: String!
    likes: Int!
    dislikes: Int!
    views: Int!
    comments: Int!
    commentsData: [Comment!]!
    userLikes: [UserInteraction!]!
    userDislikes: [UserInteraction!]!
    userComments: [UserInteraction!]!
    userViews: [UserInteraction!]!
    isActive: Boolean!
    author: String
    readFullLink: String
    ePaperLink: String
    createdAt: String
    updatedAt: String
  }

  type Category {
    id: ID!
    name: String!
    description: String
    icon: String
    color: String
    imageUrl: String
  }

  type Location {
    id: ID!
    name: String!
    description: String
  }

  type User {
    id: ID!
    googleId: String!
    email: String!
    name: String!
    profilePicture: String
    createdAt: String!
  }

  type ViralVideo {
    id: ID!
    title: String!
    description: String
    videoUrl: String!
    thumbnailUrl: String
    views: Int!
    likes: Int!
    dislikes: Int!
    createdAt: String!
  }

  type Query {
    # News queries
    news(limit: Int, offset: Int, category: String, location: String): [News!]!
    newsById(id: ID!): News
    
    # Category queries
    categories: [Category!]!
    categoryById(id: ID!): Category
    
    # Location queries
    locations: [Location!]!
    locationById(id: ID!): Location
    
    # User queries
    user(id: ID!): User
    
    # Viral videos queries
    viralVideos(limit: Int, offset: Int): [ViralVideo!]!
    viralVideoById(id: ID!): ViralVideo
  }

  type Mutation {
    # News mutations
    likeNews(newsId: ID!): News
    dislikeNews(newsId: ID!): News
    addComment(newsId: ID!, text: String!): News
    incrementViews(newsId: ID!, userId: String!, userName: String): News
    
    # Viral video mutations
    likeViralVideo(videoId: ID!): ViralVideo
    dislikeViralVideo(videoId: ID!): ViralVideo
  }
`;

module.exports = typeDefs;
