#ifndef SHARED_STATE_H
#define SHARED_STATE_H

/* 定义放在 producer.c；consumer.c 排在它之前，用于验证跨文件查找。 */
extern unsigned int g_rpm;
extern unsigned int g_index;
extern unsigned int g_samples[4];

void Sensor_Update(void);
unsigned int Control_Read(void);
unsigned int Debug_Echo(unsigned int g_rpm);

#endif
