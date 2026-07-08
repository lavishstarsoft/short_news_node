const { gql } = require('apollo-server-express');

const typeDefs = gql`
  type Comment {
    id: ID!
    text: String!
    userId: String!
    userName: String
    createdAt: String!
  }

  type DisplaySettings {
    showProfileImage: Boolean
    showName: Boolean
    showConstituency: Boolean
  }

  type RejectionStatus {
    isRejected: Boolean!
    reason: String
    feedback: String
    rejectedBy: String
    rejectedByRole: String
    rejectedAt: String
  }

  type ApprovalStatus {
    isApproved: Boolean!
    approvedBy: String
    approvedByRole: String
    approvedAt: String
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
    _id: ID # Backward compatibility
    title: String!
    content: String!
    imageUrl: String
    image_url: String # Backward compatibility
    imageUrls: [String]
    videoUrl: String
    mediaUrl: String
    media_url: String # Backward compatibility
    mediaType: String
    media_type: String # Backward compatibility
    thumbnailUrl: String
    thumbnail_url: String # Backward compatibility
    category: String!
    location: String
    language: String
    publishedAt: String!
    published_at: String # Backward compatibility
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
    authorName: String
    authorId: String
    authorRole: String
    authorProfileImage: String
    authorConstituency: String
    authorDisplaySettings: DisplaySettings
    readFullLink: String
    ePaperLink: String
    shortId: String
    createdAt: String
    updatedAt: String
    rejectionStatus: RejectionStatus
    approvalStatus: ApprovalStatus
  }

  type Category {
    id: ID!
    _id: ID # Backward compatibility
    name: String!
    displayName: String
    showToReporters: Boolean
    description: String
    icon: String
    color: String
    imageUrl: String
    image_url: String # Backward compatibility
    imageUrls: [String]
    newsCount: Int
    isActive: Boolean
  }

  type Location {
    id: ID!
    _id: ID # Backward compatibility
    name: String!
    description: String
    icon: String
    newsCount: Int
    isActive: Boolean
  }

  type NewsLanguage {
    code: String!
    name: String!
    nativeName: String!
    isDefault: Boolean!
  }

  type User {
    id: ID!
    googleId: String!
    email: String!
    name: String!
    profilePicture: String
    createdAt: String!
  }

  type UserInteractionsList {
    likedNewsIds: [ID!]!
    dislikedNewsIds: [ID!]!
    commentedNewsIds: [ID!]!
  }

  type ViralVideo {
    id: ID!
    title: String!
    description: String
    content: String
    videoUrl: String
    mediaUrl: String
    thumbnailUrl: String
    category: String!
    language: String!
    author: String
    views: Int!
    likes: Int!
    dislikes: Int!
    comments: Int!
    publishedAt: String!
    createdAt: String!
    userLikes: [UserInteraction!]!
    userDislikes: [UserInteraction!]!
    userComments: [UserInteraction!]!
  }

  type PollOption {
    id: ID!
    text: String!
    votes: Int!
    percentage: Float
  }

  type VotedUser {
    userId: String!
    optionId: ID!
  }

  type Poll {
    id: ID!
    question: String!
    language: String!
    options: [PollOption!]!
    totalVotes: Int!
    votedUsers: [VotedUser!]
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
    # Additional field to know if the current user has voted (resolved dynamically)
    userVotedOptionId: ID
  }

  type Query {
    # News queries
    news(limit: Int, offset: Int, category: String, location: String, language: String): [News!]!
    newsById(id: ID!): News
    newsByShortId(shortId: String!): News
    
    # Category queries
    categories: [Category!]!
    categoryById(id: ID!): Category
    
    # Location queries
    locations: [Location!]!
    locationById(id: ID!): Location

    # Language queries
    getActiveLanguages(forUserApp: Boolean): [NewsLanguage!]!
    
    # User queries
    user(id: ID!): User
    
    # Viral videos queries
    viralVideos(limit: Int, offset: Int, language: String): [ViralVideo!]!
    viralVideoById(id: ID!): ViralVideo

    # Personalized Interaction queries
    getUserNewsInteractions(userId: ID!): UserInteractionsList

    # Dynamic Registration Form queries
    getRegistrationFields: [RegistrationField!]!
    getReporterApplications: [ReporterApplication!]!
    getReporterApplicationById(id: ID!): ReporterApplication

    # Existing extensions
    getLiveStreamStatus: LiveStreamStatus
    getEditorById(id: ID!): Editor
    getNewsByEditor(editorId: ID!, limit: Int, includeUnpublished: Boolean): [News!]!
    getNewsById(id: ID!): News
    
    # Poll queries
    getAllPolls(userId: String, language: String): [Poll!]!
    getPollById(id: ID!, userId: String): Poll
  }

  type RegistrationField {
    id: ID!
    label: String!
    type: String!
    name: String!
    placeholder: String
    required: Boolean
    options: [String]
    order: Int
    isActive: Boolean
  }

  type ReporterApplication {
    id: ID!
    data: String! # JSON stringified map
    status: String!
    adminNotes: String
    createdAt: String!
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

    # Existing extensions
    updateLiveStreamStatus(isLive: Boolean!, url: String): LiveStreamStatus
    loginEditor(username: String!, password: String!): EditorLoginPayload
    updateEditorProfile(editorId: ID!, name: String, displayRole: String, location: String, profileImage: String): EditorProfileUpdatePayload
    registerEditor(username: String!, email: String!, password: String!, name: String, displayRole: String, location: String, mobileNumber: String, workingLanguage: String): EditorRegisterPayload
    
    # Dynamic Form Mutations
    submitReporterApplication(data: String!): ApplicationResponse
    updateRegistrationField(id: ID, label: String, type: String, name: String, placeholder: String, required: Boolean, options: [String], order: Int, isActive: Boolean): FieldResponse
    deleteRegistrationField(id: ID!): FieldResponse
    reviewReporterApplication(applicationId: ID!, status: String!, adminNotes: String): ApplicationResponse
    deleteReporterApplication(applicationId: ID!): ApplicationResponse
    
    # Poll mutations
    createPoll(question: String!, options: [String!]!): Poll
    voteOnPoll(pollId: ID!, optionId: ID!, userId: String!): Poll
  }
  
  type ReportResponse {
    success: Boolean!
    message: String!
  }

  type LiveStreamStatus {
    isLive: Boolean
    url: String
  }

  type ApplicationResponse {
    success: Boolean!
    message: String!
  }

  type FieldResponse {
    success: Boolean!
    message: String!
    field: RegistrationField
  }

  type EditorRegisterPayload {
    success: Boolean!
    message: String!
    token: String
    editor: Editor
  }

  type EditorLoginPayload {
    success: Boolean!
    message: String!
    token: String
    editor: Editor
  }

  type EditorProfileUpdatePayload {
    success: Boolean!
    message: String!
    editor: Editor
  }

  type Editor {
    id: ID!
    username: String!
    email: String!
    role: String!
    displayRole: String
    profileImage: String
    name: String
    location: String
    mobileNumber: String
    constituency: String
    workingLanguage: String
    isActive: Boolean!
    displaySettings: DisplaySettings
  }
`;

module.exports = typeDefs;
