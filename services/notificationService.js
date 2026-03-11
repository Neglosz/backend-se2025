const createNotificationService = ({ supabaseAdmin }) => {
    // Helper to Get Store Users (Owner + Managers)
    const getStoreUsers = async (storeId) => {
        try {
            const { data: store } = await supabaseAdmin
                .from('stores')
                .select('owner_id')
                .eq('id', storeId)
                .single();

            const { data: members } = await supabaseAdmin
                .from('store_members')
                .select('user_id')
                .eq('store_id', storeId);

            const ids = [store?.owner_id, ...members?.map((m) => m.user_id)].filter(Boolean);
            return [...new Set(ids)]; // Unique IDs
        } catch (e) {
            console.error('getStoreUsers Error:', e);
            return [];
        }
    };

    // Global Helper: Upsert Notification (Production Grade — supports state transitions)
    //
    // Matches by (reference_id + reference_type + user_id), NOT by type.
    // This allows in-place update when a notification changes state:
    //   e.g. stock_near_expiry → stock_expired for the same batch
    // The existing notification is updated with the new type/title/message instead of
    // creating a duplicate, giving the user a single, always-accurate alert per item.
    const upsertNotificationGlobal = async (storeId, type, title, message, category, priority, referenceId, referenceType, payload) => {
        try {
            const userIds = await getStoreUsers(storeId);
            let createdCount = 0;

            for (const userId of userIds) {
                // Find existing notification by reference (any type) — supports state transitions
                // Use .limit(1) instead of .maybeSingle() to safely handle rare duplicate rows
                // from concurrent scheduler runs. maybeSingle() throws if >1 row found,
                // which would crash the entire notification pipeline silently.
                const { data: existingRows } = await supabaseAdmin
                    .from('notifications')
                    .select('id, type, title, message')
                    .eq('user_id', userId)
                    .eq('reference_id', referenceId)
                    .eq('reference_type', referenceType)
                    .order('created_at', { ascending: false })
                    .limit(1);
                const existing = existingRows?.[0] || null;

                if (existing) {
                    // Self-heal: delete any duplicate rows that may exist from past race conditions
                    // (keep only the one we're about to update — the most recent one)
                    await supabaseAdmin
                        .from('notifications')
                        .delete()
                        .eq('user_id', userId)
                        .eq('reference_id', referenceId)
                        .eq('reference_type', referenceType)
                        .neq('id', existing.id); // keep this one, delete the rest

                    // Check if anything changed (type OR content)
                    const typeChanged = existing.type !== type;
                    const contentChanged = existing.title !== title || existing.message !== message;

                    if (typeChanged || contentChanged) {
                        // Update in-place — preserves the notification row, just changes its state
                        await supabaseAdmin
                            .from('notifications')
                            .update({
                                type,       // ← also update type (near_expiry → expired)
                                title,
                                message,
                                payload,
                                priority,
                                category,
                                is_read: false, // Reset to unread — new information
                                // NOTE: Do NOT update created_at — triggers Realtime loop
                            })
                            .eq('id', existing.id);
                        createdCount++;
                    }
                    // Content unchanged → do nothing (preserve is_read and created_at)
                } else {
                    // No existing notification — insert fresh
                    await supabaseAdmin.from('notifications').insert([{
                        store_id: storeId,
                        user_id: userId,
                        type,
                        title,
                        message,
                        category,
                        priority,
                        reference_id: referenceId,
                        reference_type: referenceType,
                        payload,
                        is_read: false,
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                    }]);
                    createdCount++;
                }
            }
            return createdCount > 0;
        } catch (e) {
            console.error('upsertNotificationGlobal Error:', e);
            return false;
        }
    };

    // Global Helper: Delete Notification (Auto-Resolve)
    const deleteNotificationGlobal = async (storeId, types, referenceId, referenceType) => {
        try {
            const typeArray = Array.isArray(types) ? types : [types];
            const userIds = await getStoreUsers(storeId);

            // Find notifications matching the criteria
            const { data: toDelete } = await supabaseAdmin
                .from('notifications')
                .select('id')
                .in('user_id', userIds)
                .eq('store_id', storeId)
                .in('type', typeArray)
                .eq('reference_id', referenceId)
                .eq('reference_type', referenceType);

            if (toDelete && toDelete.length > 0) {
                const ids = toDelete.map((n) => n.id);
                await supabaseAdmin.from('notifications').delete().in('id', ids);
            }
            return true;
        } catch (e) {
            console.error('deleteNotificationGlobal Error:', e);
            return false;
        }
    };

    return {
        upsertNotificationGlobal,
        deleteNotificationGlobal
    };
};

module.exports = { createNotificationService };
