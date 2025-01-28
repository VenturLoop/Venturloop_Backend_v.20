  import { Server } from "socket.io";
  import Message from "../models/message.js";
  import UserModel from "../models/user.js";
  import Post from "../models/post.js";
  import SavedProfile from "../models/savedProfile.js";
  import admin from "firebase-admin";
  import path from "path";
  import { fileURLToPath } from "url";
  import fs from "fs";

  // Use the correct path for the Render secret file
  const serviceAccountPath =
    "/etc/secrets/push-notification-33d0f-firebase-adminsdk-fbsvc-6c4075929f.json";

  // Check if the file exists before initializing Firebase
  if (!fs.existsSync(serviceAccountPath)) {
    console.error("Firebase service account file not found:", serviceAccountPath);
    process.exit(1); // Stop the app if the file is missing
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath),
  });

  const fcm = admin.messaging();

  export class SocketManager {
    constructor(server, config = {}) {
      this.inMemoryUsers = new Map(); // Tracks connected users (userId -> socketIds[])
      this.unreadMessagesCount = new Map(); // Tracks unread messages per user

      this.io = new Server(server, {
        ...config,
        cors: { origin: "*", methods: ["GET", "POST"] },
        pingTimeout: 60000,
        pingInterval: 25000,
        connectTimeout: 45000,
        transports: ["websocket", "polling"],
        allowEIO3: true,
        path: "/socket.io",
      });

      console.log("✅ Socket.IO initialized successfully");
      this.initializeNamespaces();
    }

    initializeNamespaces() {
      this.setupChatNamespace();
      this.setupPostNamespace();
      this.setupUserNamespace();
    }

    /** ===========================
     *     Chat Namespace
     ============================ */
    setupChatNamespace() {
      const chatNamespace = this.io.of("/chat");

      chatNamespace.on("connection", async (socket) => {
        const userId = socket.handshake.query.userId;
        if (!userId) return socket.disconnect(true);

        console.log(`[Chat] User connected: ${userId}`);
        this.addUser(userId, socket.id);

        socket.join(userId);
        await UserModel.findByIdAndUpdate(userId, {
          status: "online",
          lastSeen: new Date(),
        });

        await this.markMessagesAsDelivered(userId, socket);

        socket.on("send_message", (data) => this.handleNewMessage(socket, data));
        socket.on("message_seen", (data) => this.handleMessageSeen(socket, data));

        socket.on("disconnect", () => this.handleDisconnect(socket, userId));
      });
    }

    /** ===========================
     *     Posts Namespace
     ============================ */
    setupPostNamespace() {
      const postNamespace = this.io.of("/posts");

      postNamespace.on("connection", (socket) => {
        console.log("[Posts] User connected");

        socket.on("like_post", (data) => this.handleLikePost(socket, data));
        socket.on("comment_on_post", (data) =>
          this.handleCommentOnPost(socket, data)
        );
        socket.on("save_post", (data) => this.handleSavePost(socket, data));

        socket.on("disconnect", () => console.log("[Posts] User disconnected"));
      });
    }

    /** ===========================
     *     Users Namespace
     ============================ */
    setupUserNamespace() {
      const userNamespace = this.io.of("/users");

      userNamespace.on("connection", (socket) => {
        console.log("[Users] User connected");

        socket.on("disconnect", () => console.log("[Users] User disconnected"));
      });
    }

    /** ===========================
     *     User Session Tracking
     ============================ */
    addUser(userId, socketId) {
      if (!this.inMemoryUsers.has(userId)) {
        this.inMemoryUsers.set(userId, new Set());
      }
      this.inMemoryUsers.get(userId).add(socketId);
    }

    removeUser(userId, socketId) {
      if (this.inMemoryUsers.has(userId)) {
        const userSockets = this.inMemoryUsers.get(userId);
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
          this.inMemoryUsers.delete(userId);
        }
      }
    }

    /** ===========================
     *     Chat Functions
     ============================ */
    async handleNewMessage(socket, data) {
      try {
        const { senderId, recipientId, content, tempId } =
          typeof data === "string" ? JSON.parse(data) : data;
        if (!senderId || !recipientId || !content)
          return socket.emit("message_failed", {
            error: "Missing required fields",
          });

        const message = await Message.create({
          senderId,
          recipientId,
          content,
          status: "sent",
          timestamp: new Date(),
        });
        console.log(`[Chat] Message sent: ${message._id}`);

        const recipientSockets = this.inMemoryUsers.get(recipientId);
        if (recipientSockets) {
          recipientSockets.forEach((socketId) => {
            this.io
              .of("/chat")
              .to(socketId)
              .emit("receive_message", {
                ...message.toObject(),
                isSentByMe: false,
              });
            this.io
              .of("/chat")
              .to(socketId)
              .emit("unread_message_count", {
                count: (this.unreadMessagesCount.get(recipientId) || 0) + 1,
              });
          });
          message.isDelivered = true;
          message.deliveredAt = new Date();
          await message.save();
        } else {
          // Fetch the recipient's push token
          const recipient = await UserModel.findById(recipientId)
            .select("name pushToken profile") // Select recipient's name and profile reference
            .populate({
              path: "profile", // Nested populate for profile details
              select: "profilePhoto", // Fetch only profilePhoto
            });
          console.log(recipient);
          if (recipient && recipient.pushToken) {
            const name = recipient.profile?.name || "Someone";
            const profilePhoto = recipient.profile?.profilePhoto || "";

            await fcm.send({
              token: recipient.pushToken,
              notification: {
                title: `${name} sent you a message`,
                body: `${content.substring(0, 30)}...`,
              },
              data: {
                senderId,
                messageId: message._id.toString(),
                profilePhoto, // Include the profile photo URL in the data payload
              },
            });

            console.log(`[Push] Notification sent to: ${recipientId}`);
          }
        }

        socket.emit("message_sent_ack", {
          tempId,
          message: {
            ...message.toObject(),
            isSentByMe: true,
            isDelivered: !!recipientSockets,
          },
        });
      } catch (error) {
        console.error("[Chat] Error in handleNewMessage:", error);
        socket.emit("message_failed", { error: "Failed to send message" });
      }
    }

    async handleMessageSeen(socket, data) {
      try {
        const { messageIds, userId } =
          typeof data === "string" ? JSON.parse(data) : data;
        if (!userId || !Array.isArray(messageIds))
          return socket.emit("error", { message: "Invalid data format." });

        await Message.updateMany(
          { _id: { $in: messageIds }, recipientId: userId, isSeen: false },
          { isSeen: true, seenAt: new Date() }
        );

        this.unreadMessagesCount.set(
          userId,
          Math.max(
            0,
            (this.unreadMessagesCount.get(userId) || 0) - messageIds.length
          )
        );

        socket.emit("message_seen_ack", { messageIds });

        messageIds.forEach((messageId) => {
          const senderSockets = this.inMemoryUsers.get(userId);
          if (senderSockets) {
            senderSockets.forEach((socketId) =>
              this.io
                .of("/chat")
                .to(socketId)
                .emit("message_seen", { messageId, isSeen: true })
            );
          }
        });
      } catch (error) {
        console.error("[Chat] Error in handleMessageSeen:", error);
      }
    }

    async markMessagesAsDelivered(userId, socket) {
      try {
        const undeliveredMessages = await Message.find({
          recipientId: userId,
          isDelivered: false,
        });

        undeliveredMessages.forEach(async (message) => {
          message.isDelivered = true;
          message.deliveredAt = new Date();
          await message.save();
          socket.emit("receive_message", {
            ...message.toObject(),
            isSentByMe: false,
          });
        });

        console.log(
          `[Chat] Marked ${undeliveredMessages.length} messages as delivered`
        );
      } catch (error) {
        console.error("[Chat] Error in markMessagesAsDelivered:", error);
      }
    }

    /** ===========================
     *     Post Functions
     ============================ */

    async handleLikePost(socket, data) {
      try {
        const { userId, postId } =
          typeof data === "string" ? JSON.parse(data) : data;
        if (!userId || !postId) return;

        const isLiked = await Post.exists({ _id: postId, "likes.users": userId });
        const updateQuery = isLiked
          ? { $pull: { "likes.users": userId }, $inc: { "likes.count": -1 } }
          : { $addToSet: { "likes.users": userId }, $inc: { "likes.count": 1 } };

        const updatedPost = await Post.findByIdAndUpdate(postId, updateQuery, {
          new: true,
        });

        // Fetch the user who liked the post (name and profilePhoto)
        const userWhoLiked = await UserModel.findById(userId)
          .select("name profile") // Select recipient's name and profile reference
          .populate({
            path: "profile", // Nested populate for profile details
            select: "profilePhoto", // Fetch only profilePhoto
          });

        // Fetch the post owner and send a notification
        const postOwner = await UserModel.findById(updatedPost.userData);
        // if (postOwner) {
        //   const notificationTitle = "Post Liked";
        //   const notificationBody = userWhoLiked
        //     ? `${userWhoLiked.name} liked your post.`
        //     : "Someone liked your post.";

        //   console.log(`[Push] Notification sent to post owner: ${postOwner._id}`);
        // }

        socket.emit("like_updated", {
          postId,
          likesCount: updatedPost.likes.count,
          likedByUser: !isLiked,
        });
        console.log(updatedPost, postOwner);
      } catch (error) {
        console.error("[Posts] Error in handleLikePost:", error);
      }
    }

    /** ===========================
     *     Comment on Post
     ============================ */
    async handleCommentOnPost(socket, data) {
      try {
        const { userId, postId, comment } =
          typeof data === "string" ? JSON.parse(data) : data;
        if (!userId || !postId || !comment) return;

        const newComment = {
          userId,
          text: comment,
          timestamp: new Date(),
        };

        const updatedPost = await Post.findByIdAndUpdate(
          postId,
          { $push: { comments: newComment }, $inc: { "comments.count": 1 } },
          { new: true }
        );

        this.io
          .of("/posts")
          .emit("comment_added", { postId, comment: newComment });
        socket.emit("comment_success", {
          postId,
          commentsCount: updatedPost.comments.count,
        });

        // Fetch post owner for notification
        // Fetch the user who commented
        const userWhoCommented = await UserModel.findById(userId)
          .select("name profile") // Select commenter's name and profile reference
          .populate({
            path: "profile", // Nested populate for profile details
            select: "profilePhoto", // Fetch only profilePhoto
          });

        // // Fetch the post owner and send a notification
        // const postOwner = await UserModel.findById(updatedPost.ownerId).select(
        //   "pushToken"
        // );

        // if (postOwner && postOwner.pushToken) {
        //   const notificationTitle = "New Comment on Your Post";
        //   const notificationBody = userWhoCommented
        //     ? `${userWhoCommented.name} commented: "${comment}"`
        //     : "Someone commented on your post.";

        //   await fcm.send({
        //     token: postOwner.pushToken,
        //     notification: {
        //       title: notificationTitle,
        //       body: notificationBody,
        //     },
        //     data: {
        //       postId,
        //       userId,
        //       userName: userWhoCommented?.name || "Anonymous",
        //       userProfilePhoto: userWhoCommented?.profile?.profilePhoto || "", // Nested access for profile photo
        //       comment,
        //     },
        //   });
        //   console.log(`[Push] Notification sent to post owner: ${postOwner._id}`);
        // }
      } catch (error) {
        console.error("[Posts] Error in handleCommentOnPost:", error);
      }
    }

    /** ===========================
     *     Save/Unsave Post
     ============================ */
     async handleSavePost(socket, data) {
      try {
        const { userId, postId } =
          typeof data === "string" ? JSON.parse(data) : data;
        if (!userId || !postId) return;
  
        // Log for debugging
        console.log(userId, postId);
  
        // Start a session for atomic transactions
        const session = await mongoose.startSession();
        session.startTransaction();
  
        try {
          // Fetch the user and post simultaneously to improve performance
          const [user, post, savedProfile] = await Promise.all([
            UserModel.findById(userId),
            Post.findById(postId),
            SavedProfile.findOne({ userId }).session(session), // Fetch the saved profile for this user
          ]);
  
          // If either user or post is not found, return early
          if (!user || !post) {
            return socket.emit("error", { message: "User or Post not found" });
          }
  
          // Check if the post is already saved by the user
          const isSaved =
            savedProfile && savedProfile.savedPostIds.includes(postId);
  
          // Update the post's save count
          const postUpdate = isSaved
            ? { $pull: { saves: userId }, $inc: { savesCount: -1 } }
            : { $addToSet: { saves: userId }, $inc: { savesCount: 1 } };
  
          // Create the update query for the SavedProfile model
          const savedProfileUpdate = isSaved
            ? { $pull: { savedPostIds: postId } }
            : { $addToSet: { savedPostIds: postId } };
  
          // Perform the updates in a transaction
          await Promise.all([
            Post.findByIdAndUpdate(postId, postUpdate, { session }),
            SavedProfile.findOneAndUpdate({ userId }, savedProfileUpdate, {
              session,
              upsert: true,
            }), // upsert to create saved profile if it doesn't exist
          ]);
  
          // Commit the transaction
          await session.commitTransaction();
          session.endSession();
  
          // Fetch the updated post to get the latest savesCount
          const updatedPost = await Post.findById(postId);
  
          // Emit the update to the client with the updated savesCount
          socket.emit("save_updated", {
            postId,
            isSaved: !isSaved,
            savesCount: updatedPost.savesCount, // Emit the updated savesCount
          });
        } catch (error) {
          // Rollback the transaction in case of an error
          await session.abortTransaction();
          session.endSession();
          console.error("[Posts] Error in handleSavePost:", error);
          socket.emit("error", { message: "Failed to save post" });
        }
      } catch (error) {
        console.error("[Posts] Error in handleSavePost:", error);
        socket.emit("error", { message: "Unexpected error occurred" });
      }
    }

    async handleDisconnect(socket, userId) {
      this.removeUser(userId, socket.id);
      await UserModel.findByIdAndUpdate(userId, {
        status: "offline",
        lastSeen: new Date(),
      });
      console.log(`[User] Disconnected: ${userId}`);
    }
  }
