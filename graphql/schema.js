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
    id: ID
    userId: String!
    userName: String!
    userEmail: String
    comment: String
    timestamp: String!
    likes: [CommentLike!]!
  }

  type CommentLike {
    userId: String!
    userName: String!
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
    icon: String
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
    content: String
    videoUrl: String!
    mediaUrl: String
    thumbnailUrl: String
    category: String
    author: String
    views: Int!
    likes: Int!
    dislikes: Int!
    comments: Int!
    createdAt: String!
    userLikes: [UserInteraction!]!
    userDislikes: [UserInteraction!]!
    userComments: [UserInteraction!]!
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
    addComment(newsId: ID!, userId: String!, comment: String!): News
    interactWithNews(newsId: ID!, action: String!, userId: String!, userName: String!, userEmail: String, commentText: String): News
    incrementViews(newsId: ID!, userId: String, userName: String): News
    likeNews(newsId: ID!): News
    dislikeNews(newsId: ID!): News
    likeComment(newsId: ID!, commentId: ID!, userId: String!, userName: String!, userEmail: String!): News
    deleteComment(newsId: ID!, commentId: ID!, userId: String!): News
    interactWithViralVideo(videoId: ID!, action: String!, userId: String!, userName: String!, userEmail: String, commentText: String): ViralVideo
    likeViralVideoComment(videoId: ID!, commentText: String!, userId: String!, userName: String!): ViralVideo
    deleteViralVideoComment(videoId: ID!, commentId: String, commentText: String, userId: String!, timestamp: String): ViralVideo
    
    # Report mutations (migrated from REST API)
    reportNews(newsId: ID!, reason: String!, description: String!, userId: String!, userName: String!, userEmail: String!): ReportResponse
    reportComment(newsId: ID!, commentText: String!, commentUserId: String!, commentUserName: String!, userId: String!, userName: String!, userEmail: String!, reason: String!, additionalDetails: String): ReportResponse
    reportViralVideoComment(videoId: ID!, commentText: String!, commentUserId: String!, commentUserName: String!, userId: String!, userName: String!, userEmail: String!, reason: String!, additionalDetails: String): ReportResponse
  }
  
  type ReportResponse {
    success: Boolean!
    message: String!
  }

  type LiveStreamStatus {
    isLive: Boolean
    url: String
  }

  extend type Query {
    getLiveStreamStatus: LiveStreamStatus
  }

  extend type Mutation {
    updateLiveStreamStatus(isLive: Boolean!, url: String): LiveStreamStatus
  }
`;

module.exports = typeDefs;
